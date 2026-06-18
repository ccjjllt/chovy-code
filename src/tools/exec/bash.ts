/**
 * `bash` — Tool Protocol v2 shell executor (step-09).
 *
 * This is chovy-code's most powerful built-in tool. It runs a shell
 * command through the platform's default shell (PowerShell on Windows,
 * `/bin/bash -lc` on POSIX), enforces a per-call timeout, truncates
 * pathological output, dispatches a danger preflight built on top of our
 * lightweight bash AST (`./ast.ts`), and scaffolds the hooks that
 * step-14 (sandbox) and step-23 (background task system) will inhabit.
 *
 * What this step ships:
 *   - `schema` exactly as `docs/step-09 §schema` requires (Zod 3).
 *   - AST-derived danger preflight that distinguishes `deny` (rm -rf /,
 *     fork bomb, curl | sh, chmod -R 777) from `ask` (git push --force,
 *     unparseable input).
 *   - Cross-platform spawn: PowerShell on win32 (with `cmd` fallback via
 *     `CHOVY_BASH_SHELL=cmd` env), `/bin/bash -lc` elsewhere.
 *   - Conservative `~` / `$HOME` expansion *before* the command reaches
 *     the shell (this matches the spec). We deliberately do NOT touch
 *     other variables — the shell knows its own expansion rules better
 *     than we do.
 *   - `EndTruncatingAccumulator` for stdout/stderr (30 KiB cap each).
 *   - `ASSISTANT_BLOCKING_BUDGET_MS = 15s` auto-background: when a
 *     foreground call exceeds the budget we *terminate* the child and
 *     respond with `{ ok: true, content: "... handle=bg_..." }`. The real
 *     "keep running detached, deliver result later" semantics belong to
 *     step-23's task system; we just emit the handle id so the model can
 *     reference it and the UI can grow the panel.
 *   - Hint stripping: `<chovy-hint version="1" .../>` self-closing tags
 *     are pulled out of stdout/stderr and parked in a single-slot
 *     module-level register, mirroring cc-haha's `claudeCodeHints.ts`.
 *
 * What this step does NOT do (deliberately punted):
 *   - Permission engine integration. `checkPermissions` returns the
 *     preflight outcome based purely on AST + pattern matching; the
 *     6-layer engine (step-12) will merge it with config rules, mode,
 *     hooks, and user prompts.
 *   - Sandbox. step-14 lands the real `harness/sandbox` — `shouldUseSandbox`
 *     (AST-aware) + `buildSandboxSpawnArgs` (bwrap on POSIX, strict-env +
 *     ulimit fallback). The bash tool isolates network/privileged/out-of-cwd
 *     commands behind a filtered-env child.
 *   - True background lifecycle. Step-23 owns the task registry; here we
 *     just generate handle ids and remember them in-process for the
 *     duration of the run.
 *
 * Why the lean/full pair matters: this is the most expensive tool to
 * describe (the full spec is huge), so the ATP allocator will keep it on
 * `lean` most of the time and only upgrade when keywords match
 * (`fullTriggers`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir, platform as osPlatform } from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { logger } from "../../logger/index.js";
import {
  buildSandboxSpawnArgs,
  shouldUseSandbox,
  type SpawnSandboxPlan,
} from "../../harness/sandbox/index.js";
import type { ChovyConfig } from "../../config/index.js";
import type {
  PermissionPreflight,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types/index.js";

import { parseBashCommand, type BashParseResult } from "./ast.js";
import {
  classifyCommands,
  isAllReadOnly,
  type CommandClass,
} from "./classification.js";
import { EndTruncatingAccumulator } from "./outputAccumulator.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default timeout for a single call (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard cap so a single call cannot block the agent for too long (10 min). */
const MAX_TIMEOUT_MS = 600_000;
/** Floor — anything below this is almost certainly a user typo. */
const MIN_TIMEOUT_MS = 1_000;

/**
 * After this many milliseconds, a still-running foreground call is
 * transparently moved to a background handle. The model sees a result
 * immediately and can poll later via the task system (step-23).
 * `docs/step-09 §5` calls this `ASSISTANT_BLOCKING_BUDGET_MS`.
 */
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

// ── Hint slot (cc-haha claudeCodeHints.ts equivalent) ─────────────────────

/**
 * Self-closing chovy-hint tag. The version attribute is required so the
 * shape stays forward-compatible: future versions can expose new
 * attributes without breaking old runs.
 *
 * Example matches:
 *   <chovy-hint version="1" type="suggest-skill" name="commit" />
 *   <chovy-hint version="1" type="note">…</chovy-hint>  ← NOT matched
 *                                                         (we only support
 *                                                          self-closing)
 */
const HINT_RE = /<chovy-hint\s+version="1"\s+([^>]*?)\/\s*>/g;

export interface ChovyHint {
  /** Raw attribute soup; parsed downstream when consumers need it. */
  attrs: string;
  /** Convenience map of attribute → value (best-effort parse). */
  parsed: Record<string, string>;
  /** When the hint was observed. */
  ts: number;
}

/**
 * Single-slot register. Cc-haha uses a single most-recent slot too —
 * multi-hint queues add complexity for very little value. The Memory
 * system (step-24) will be the long-term sink for these.
 */
let lastHint: ChovyHint | null = null;

/** Read the most recent hint observed in any bash tool call. */
export function peekLastHint(): ChovyHint | null {
  return lastHint;
}

/** Reset the hint slot — primarily for tests. */
export function clearHintSlot(): void {
  lastHint = null;
}

/**
 * Strip every `<chovy-hint ... />` tag from `text`, store the most recent
 * one in the module-level slot, and return the cleaned text. Tag content
 * is intentionally never returned to the model.
 */
function extractAndStripHints(text: string): string {
  let last: ChovyHint | null = null;
  const cleaned = text.replace(HINT_RE, (_m, attrsRaw: string) => {
    const attrs = attrsRaw.trim();
    last = { attrs, parsed: parseAttrs(attrs), ts: Date.now() };
    return "";
  });
  if (last) lastHint = last;
  return cleaned;
}

/** Tiny attribute parser. Handles `key="value"` and `key=value` pairs. */
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w-]*)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out[m[1]!] = m[3] ?? m[4] ?? "";
  }
  return out;
}

// ── Background task registry (placeholder for step-23) ────────────────────

interface BackgroundTask {
  handle: string;
  command: string;
  startedAt: number;
  child: ChildProcess;
}

const bgTasks = new Map<string, BackgroundTask>();

function mintBackgroundHandle(): string {
  return `bg_${randomBytes(4).toString("hex")}`;
}

/** Exposed so the smoke script / step-23 can introspect. */
export function listBackgroundTasks(): Array<{
  handle: string;
  command: string;
  startedAt: number;
}> {
  return Array.from(bgTasks.values()).map(({ handle, command, startedAt }) => ({
    handle,
    command,
    startedAt,
  }));
}

// ── Sandbox hook (step-14) ─────────────────────────────────────────────────

/**
 * Sandbox handle shape the bash tool calls against. step-14 supplies a
 * real implementation from `src/harness/sandbox/`; the barrel
 * (`tools/exec/index.ts`) re-exports this type so callers that imported
 * the step-09 stub keep compiling.
 *
 * The in-tool `run()` path calls the AST-aware
 * `harness/sandbox.shouldUseSandbox(ast, opts)` directly (the command is
 * already parsed, no double-parse). This string-based interface is kept
 * for external callers / tests that only have the raw command; they can
 * build a `SandboxLike` by re-parsing.
 */
export interface SandboxLike {
  shouldUseSandbox(command: string): boolean;
}

/**
 * Resolve the effective permission mode for the sandbox decision. The
 * agent loop passes `ctx.config.permissionMode` (frozen field), but some
 * call sites (tests, one-shot `chat`) construct a ctx without it; we fall
 * back to `"default"` so the sandbox errs toward isolation.
 */
function effectiveMode(config?: ChovyConfig): ChovyConfig["permissionMode"] {
  return config?.permissionMode ?? "default";
}

// ── Danger evaluator ──────────────────────────────────────────────────────

/**
 * Patterns that always result in `deny`. The shapes here come from
 * `docs/step-09 §3` and cc-haha's `bashSecurity.ts` deny list; we keep
 * them narrow (false negatives are OK because the engine still asks for
 * unrecognized mutating commands) and prefer testing against the AST
 * argv rather than the raw command line so quoting tricks can't bypass
 * them.
 */
function evaluateDanger(
  cmd: string,
  parse: BashParseResult,
): PermissionPreflight {
  const raw = cmd.trim();

  // 1. Fork bomb — unmistakable signature; nothing legitimate looks like this.
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/.test(raw)) {
    return {
      outcome: "deny",
      reason: "fork bomb pattern",
      matchedRule: "Bash(fork-bomb)",
    };
  }

  // 2. AST not available? Treat as high-risk so the user is asked.
  if (!parse.ok) {
    return {
      outcome: "ask",
      reason:
        parse.kind === "empty"
          ? "empty command"
          : `AST parse failed (${parse.reason}); treating as high-risk`,
    };
  }

  // 3. Pipe-to-shell — `curl … | sh`, `wget … | bash`. The pattern is the
  //    second-or-later segment in a `|` chain having a shell as argv[0].
  for (let i = 1; i < parse.commands.length; i++) {
    const prev = parse.commands[i - 1]!;
    if (prev.trailingOp !== "|") continue;
    const base = (parse.commands[i]!.argv[0] ?? "").toLowerCase();
    const baseName = base.split(/[\\/]/).pop() ?? base;
    if (["sh", "bash", "zsh", "fish", "pwsh", "powershell"].includes(baseName)) {
      return {
        outcome: "deny",
        reason: "pipe-to-shell pattern (curl … | sh)",
        matchedRule: "Bash(pipe-to-shell)",
      };
    }
  }

  // 4. Per-segment scans.
  for (const c of parse.commands) {
    const argv = c.argv;
    const base = (argv[0] ?? "").toLowerCase();
    const baseName = base.split(/[\\/]/).pop() ?? base;

    // 4a. `rm -rf` against /, ., $HOME, ~, or with a bare unquoted glob+var
    //     combo (the classic "rm $UNSET/$VAR" foot-gun).
    if (baseName === "rm") {
      const flags = argv.slice(1).filter((t) => t.startsWith("-"));
      const opers = argv.slice(1).filter((t) => !t.startsWith("-"));
      const recursive = flags.some((f) => /r/.test(f)) && flags.some((f) => /f/.test(f));
      if (recursive) {
        for (const tok of opers) {
          if (
            tok === "/" ||
            tok === "/*" ||
            tok === "." ||
            tok === "./" ||
            tok === ".." ||
            tok === "../" ||
            tok === "~" ||
            tok === "~/" ||
            tok === "$HOME" ||
            tok === '"$HOME"' ||
            tok === "${HOME}"
          ) {
            return {
              outcome: "deny",
              reason: `destructive rm -rf target: ${tok}`,
              matchedRule: "Bash(rm -rf:catastrophic)",
            };
          }
        }
        // Unquoted-var + glob heuristic: `rm -rf $X/*` where $X may be empty.
        for (const tok of opers) {
          if (/^\$[A-Za-z_][\w]*(\/?\*)?$/.test(tok)) {
            return {
              outcome: "deny",
              reason: `rm -rf with unquoted variable: ${tok}`,
              matchedRule: "Bash(rm -rf:unquoted-var)",
            };
          }
        }
      }
    }

    // 4b. `chmod -R 777` — broad recursive permission flip.
    if (baseName === "chmod") {
      const hasR = argv.slice(1).some(
        (t) => t === "-R" || t === "--recursive",
      );
      const has777 = argv.slice(1).some((t) => /^[0-7]?777$/.test(t));
      if (hasR && has777) {
        return {
          outcome: "deny",
          reason: "chmod -R 777 (catastrophic permission flip)",
          matchedRule: "Bash(chmod -R 777)",
        };
      }
    }

    // 4c. `git push --force` / `-f` → ask (the user might want this).
    if (baseName === "git") {
      const rest = argv.slice(1);
      if (rest[0] === "push") {
        for (const t of rest) {
          if (t === "--force" || t === "-f" || t === "--force-with-lease") {
            return {
              outcome: "ask",
              reason: `git push ${t} — requires explicit confirmation`,
              matchedRule: "Bash(git push:force)",
            };
          }
        }
      }
      // 4d. `git push --no-verify` is in AGENTS.md §5 forbidden list.
      if (rest.includes("--no-verify")) {
        return {
          outcome: "deny",
          reason: "git --no-verify is forbidden by AGENTS.md §5",
          matchedRule: "Bash(git:no-verify)",
        };
      }
    }
  }

  // 5. Subshell + heredoc bias: not denied, but emit `ask` so the user
  //    gets a chance to inspect arbitrary code injection.
  if (parse.hasHeredoc) {
    return {
      outcome: "ask",
      reason: "heredoc present — opaque payload",
    };
  }
  if (parse.hasSubshell) {
    return {
      outcome: "ask",
      reason: "subshell / command substitution present",
    };
  }

  // 6. Read-only fast path: pure `READ`/`SEARCH`/`LIST` chains are safe.
  const classes = classifyCommands(parse.commands);
  if (classes.every((k) => k === "READ" || k === "SEARCH" || k === "LIST")) {
    return { outcome: "allow", reason: "all read-only commands" };
  }

  // 7. Everything else: defer to the engine. Today we surface `ask` so
  //    chovy doesn't silently mutate; step-12 may downgrade to `allow`
  //    if a matching allow-rule exists.
  return {
    outcome: "ask",
    reason: "mutating or unknown command; needs approval",
  };
}

// ── Cross-platform shell selection ────────────────────────────────────────

function pickShell(): { cmd: string; args: (script: string) => string[] } {
  if (osPlatform() === "win32") {
    // PowerShell is the default per spec. Allow override via env so users
    // on legacy systems / pinned cmd workflows can opt out.
    const override = process.env.CHOVY_BASH_SHELL?.toLowerCase();
    if (override === "cmd") {
      const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
      return {
        cmd: comspec,
        args: (script) => ["/d", "/s", "/c", script],
      };
    }
    // Prefer `pwsh` (PowerShell 7+) when available; fall back to legacy
    // `powershell.exe`. We don't probe the filesystem — Node's spawn will
    // raise ENOENT and the user sees a clean error.
    const ps = override === "pwsh" ? "pwsh.exe" : "powershell.exe";
    return {
      cmd: ps,
      args: (script) => ["-NoProfile", "-NonInteractive", "-Command", script],
    };
  }
  // POSIX: bash login shell so PATH from the user's profile is picked up.
  return {
    cmd: "/bin/bash",
    args: (script) => ["-lc", script],
  };
}

/**
 * Expand `~` and `$HOME` to the user's home directory. Conservative — we
 * only touch unambiguous occurrences so quoted strings inside the command
 * are not rewritten. On POSIX the shell can do this itself; on Windows
 * (PowerShell / cmd) `~` is not honored the way bash does it, so we hand
 * the shell a pre-resolved string.
 */
function expandHomeRefs(input: string): string {
  const home = homedir();
  // Replace `$HOME` and `${HOME}` only outside single-quoted regions.
  // Single-quoted `'$HOME'` should remain literal in bash.
  let out = "";
  let q: "none" | "single" | "double" = "none";
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (q === "single") {
      if (c === "'") q = "none";
      out += c;
      continue;
    }
    if (q === "double") {
      if (c === "\\" && i + 1 < input.length) { out += c + input[i + 1]; i++; continue; }
      if (c === '"') q = "none";
      // Still expand $HOME inside double quotes (bash does).
      if (input.startsWith("$HOME", i) && !/[A-Za-z0-9_]/.test(input[i + 5] ?? "")) {
        out += home;
        i += 4;
        continue;
      }
      if (input.startsWith("${HOME}", i)) {
        out += home;
        i += 6;
        continue;
      }
      out += c;
      continue;
    }
    if (c === "'") { q = "single"; out += c; continue; }
    if (c === '"') { q = "double"; out += c; continue; }
    // Leading-token `~` or `~/...` — replace only when at word boundary.
    if (
      c === "~" &&
      (i === 0 || /[\s=:]/.test(input[i - 1] ?? "")) &&
      (i + 1 >= input.length || /[\s/]/.test(input[i + 1] ?? ""))
    ) {
      out += home;
      continue;
    }
    if (input.startsWith("$HOME", i) && !/[A-Za-z0-9_]/.test(input[i + 5] ?? "")) {
      out += home;
      i += 4;
      continue;
    }
    if (input.startsWith("${HOME}", i)) {
      out += home;
      i += 6;
      continue;
    }
    out += c;
  }
  return out;
}

// ── Spawn helpers ─────────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durMs: number;
  timedOut: boolean;
  backgrounded: boolean;
  bgHandle?: string;
}

interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  runInBackground: boolean;
  abortSignal?: AbortSignal;
  /**
   * Optional sandbox spawn plan (step-14). When present, replaces the
   * default `pickShell()` selection + `process.env` with a filtered-env
   * (and bwrap-wrapped on POSIX when available) child. `undefined` ⇒ run
   * unsandboxed (the historical behavior; the permission engine is the
   * gate).
   */
  sandboxPlan?: SpawnSandboxPlan;
}

function execShellCommand(command: string, opts: ExecOptions): Promise<ExecResult> {
  // step-14: when the sandbox decided this command needs isolation,
  // `buildSandboxSpawnArgs` produced the cmd/args/env. Otherwise fall
  // back to the platform default shell + full process.env.
  const picked = opts.sandboxPlan
    ? {
        cmd: opts.sandboxPlan.cmd,
        shellArgs: opts.sandboxPlan.args,
        env: opts.sandboxPlan.env,
      }
    : (() => {
        const { cmd, args } = pickShell();
        return { cmd, shellArgs: args(command), env: process.env };
      })();
  const { cmd, shellArgs, env } = picked;
  const t0 = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, shellArgs, {
        cwd: opts.cwd,
        env,
        // `detached: true` on POSIX puts the child in its own process
        // group so we can SIGTERM the whole tree. On Windows the spawn
        // already gets its own process group when no shell wrap is used.
        detached: osPlatform() !== "win32" && opts.runInBackground,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    // ── Background path: detach and return immediately. ────────────────
    if (opts.runInBackground) {
      const handle = mintBackgroundHandle();
      bgTasks.set(handle, {
        handle,
        command,
        startedAt: t0,
        child,
      });
      // On POSIX we can `unref()` so the parent can exit independently.
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        durMs: Date.now() - t0,
        timedOut: false,
        backgrounded: true,
        bgHandle: handle,
      });
      return;
    }

    const stdout = new EndTruncatingAccumulator();
    const stderr = new EndTruncatingAccumulator();
    let timedOut = false;
    let autoBg = false;
    let bgHandle: string | undefined;

    child.stdout?.on("data", (chunk: Buffer | string) =>
      stdout.append(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      stderr.append(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
    );

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(bgTimer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    opts.abortSignal?.addEventListener("abort", onAbort);

    // Hard timeout — kill the process and let `close` resolve below.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);

    // Soft "blocking budget" — auto-move to background (here: terminate and
    // return a synthetic handle so step-23 can wire the real lifecycle).
    const bgTimer = setTimeout(() => {
      // Only auto-bg if the call has actually been running long enough
      // *and* the user didn't cap the call below the budget.
      if (opts.timeoutMs <= ASSISTANT_BLOCKING_BUDGET_MS) return;
      autoBg = true;
      bgHandle = mintBackgroundHandle();
      bgTasks.set(bgHandle, {
        handle: bgHandle,
        command,
        startedAt: t0,
        child,
      });
      try {
        // step-23 will own keeping the child alive; for now we terminate
        // so the agent gets unblocked. The handle records the intent.
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS);

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code,
        signal,
        durMs: Date.now() - t0,
        timedOut,
        backgrounded: autoBg,
        bgHandle: autoBg ? bgHandle : undefined,
      });
    });
  });
}

// ── Schema ────────────────────────────────────────────────────────────────

const argsSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("Single shell command. Multi-step: use && or ;"),
  description: z
    .string()
    .optional()
    .describe("Short human-readable label for status-line / UI."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory; absolute path. Defaults to process.cwd()."),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe("Per-call timeout in milliseconds (default 120s, max 600s)."),
  runInBackground: z
    .boolean()
    .optional()
    .describe("When true, detach immediately and return a handle id."),
});

type Args = z.infer<typeof argsSchema>;

// ── Tool ──────────────────────────────────────────────────────────────────

export const bashTool: Tool<typeof argsSchema> = {
  name: "bash",
  version: 2,
  family: "exec",

  // Conservative default — most bash invocations mutate something.
  // `run()` upgrades this dynamically via `isAllReadOnly` so the
  // permission engine can still fast-path `cat | grep` chains.
  isReadOnly: false,
  canUseWithoutAsk: false,

  desc: {
    lean: "Run a shell command. Use absolute paths. Avoid destructive ops.",
    full:
      "Execute a shell command in the user's default shell\n" +
      "(PowerShell on Windows, /bin/bash -lc on POSIX).\n\n" +
      "- `command`: single line; chain with `&&` / `;` when needed.\n" +
      "- `timeoutMs`: 1s–600s; default 120s. Long-running calls (≥15s)\n" +
      "  are transparently moved to a background handle.\n" +
      "- `runInBackground: true` detaches immediately and returns a handle.\n" +
      "- `cwd`: must be absolute when set.\n" +
      "- Prefer dedicated tools over `find` / `grep` / `cat` / `sed` /\n" +
      "  `awk` — the fs tool family is faster and safer.\n" +
      "- NEVER edit `~/.gitconfig`, `~/.bashrc`, `~/.zshrc`, `~/.ssh/*`,\n" +
      "  the project `.git/` directory, or any credentials file.\n" +
      "- NEVER `git push --force` / `--force-with-lease` without the user\n" +
      "  explicitly authorizing it in the same turn.\n" +
      "- NEVER pass `--no-verify` to git.\n" +
      "- `rm -rf` of `/`, `.`, `..`, `~`, or `$HOME` is hard-denied.\n" +
      "- `chmod -R 777` is hard-denied.\n" +
      "- Pipe-to-shell (`curl … | sh`) is hard-denied.",
    examples: [
      `bash({ command: "bun run typecheck" })`,
      `bash({ command: "ls -la /abs/path" })`,
      `bash({ command: "bun test --watch", runInBackground: true })`,
    ],
  },

  fullTriggers: [
    // Verbs that strongly suggest the user wants to run something.
    /\b(run|exec|execute|shell|bash|cmd|powershell)\b/i,
    // Common dev commands that benefit from the full safety prose.
    /\b(install|build|test|lint|typecheck|deploy|push|commit)\b/i,
  ],

  schema: argsSchema,

  userFacingName(args) {
    return args.description ?? `Bash: ${truncate(args.command, 60)}`;
  },

  checkPermissions(args): PermissionPreflight {
    const parse = parseBashCommand(args.command);
    // Cache the parse result for `run()` to reuse — except we can't put
    // it on `args` (zod-validated, frozen). The cost of re-parsing is
    // negligible (<1 ms for typical commands).
    return evaluateDanger(args.command, parse);
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    const expandedCommand = expandHomeRefs(args.command);
    const parse = parseBashCommand(expandedCommand);

    // Reconfirm the danger preflight — `checkPermissions` is layer-1 only
    // and the engine may have been bypassed in test contexts. We will
    // ALWAYS refuse to run a hard-deny pattern regardless of caller
    // wiring; ask-level decisions are left to the engine (step-12).
    const verdict = evaluateDanger(expandedCommand, parse);
    if (verdict.outcome === "deny") {
      return {
        ok: false,
        content: `Refused: ${verdict.reason ?? "policy"}`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0, cmd: args.command },
        structuredOutput: {
          kind: "denied",
          reason: verdict.reason,
          matchedRule: verdict.matchedRule,
        },
      };
    }

    const cwd = args.cwd ?? ctx?.cwd ?? process.cwd();
    const timeoutMs = args.timeoutMs;
    // step-14: decide whether to isolate the child. `shouldUseSandbox`
    // takes the already-parsed AST (no double-parse) + the effective
    // permission mode from ctx. When true, build the spawn plan (bwrap on
    // POSIX when available, strict-env + ulimit otherwise). A degraded
    // plan (no bwrap) is logged but never blocks — spec §风险.
    let sandboxPlan: SpawnSandboxPlan | undefined;
    if (shouldUseSandbox(parse, { mode: effectiveMode(ctx?.config), command: expandedCommand, cwd })) {
      sandboxPlan = buildSandboxSpawnArgs(expandedCommand, {
        cwd,
        timeoutMs,
        abortSignal: ctx?.abortSignal,
      });
      logger.debug("bash: sandbox requested", {
        command: truncate(expandedCommand, 80),
        useBwrap: sandboxPlan.useBwrap,
        degraded: sandboxPlan.degraded,
      });
      if (sandboxPlan.degraded) {
        logger.warn("bash: sandbox degraded (bwrap unavailable or Windows); using strict-env fallback", {
          command: truncate(expandedCommand, 80),
        });
      }
    }

    let res: ExecResult;
    try {
      res = await execShellCommand(expandedCommand, {
        cwd,
        timeoutMs,
        runInBackground: args.runInBackground === true,
        // Honor a caller-provided abort signal so Ctrl-C / agent cancel
        // tears the child process down. Sub-agents (step-18) get their
        // own controller per AGENTS.md §9.
        abortSignal: ctx?.abortSignal,
        // step-14: the sandbox spawn plan (undefined ⇒ unsandboxed).
        sandboxPlan,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("bash spawn failed", { error: msg, command: truncate(expandedCommand, 80) });
      return {
        ok: false,
        content: `Error spawning shell: ${msg}`,
        errorCode: "INTERNAL",
        meta: { durMs: Date.now() - t0, cmd: args.command },
      };
    }

    // ── Background paths ─────────────────────────────────────────────
    if (res.backgrounded || res.bgHandle) {
      const handle = res.bgHandle!;
      const reason = res.backgrounded
        ? `auto-backgrounded after ${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s`
        : `started in background`;
      // The agent loop wrapper emits the canonical `tool.call` telemetry
      // for every tool invocation; tools MUST NOT emit it themselves
      // (avoids double-counting in step-27 context monitor).
      return {
        ok: true,
        content:
          `Command ${reason}; handle=${handle}.\n` +
          `Poll with the task system (step-23) when it ships.`,
        structuredOutput: {
          kind: "backgrounded",
          handle,
          command: args.command,
        },
        meta: {
          cmd: args.command,
          durMs: res.durMs,
        },
      };
    }

    // ── Foreground completion ─────────────────────────────────────────
    const stdoutClean = extractAndStripHints(res.stdout);
    const stderrClean = extractAndStripHints(res.stderr);

    const exitOk = res.exitCode === 0 && !res.timedOut;
    const classes: CommandClass[] = parse.ok
      ? classifyCommands(parse.commands)
      : [];
    const readOnlyChain = parse.ok && isAllReadOnly(parse.commands);

    let summary = "";
    if (res.timedOut) {
      summary = `[timeout after ${timeoutMs}ms]\n`;
    } else if (res.exitCode !== 0) {
      summary = `[exit ${res.exitCode}${res.signal ? `, signal ${res.signal}` : ""}]\n`;
    }

    const body =
      (stdoutClean ? stdoutClean : "") +
      (stderrClean
        ? (stdoutClean ? "\n--- stderr ---\n" : "") + stderrClean
        : "");

    const content =
      summary + (body !== "" ? body : exitOk ? "(no output)" : "(no output)");

    return {
      ok: exitOk,
      content,
      errorCode: exitOk ? undefined : res.timedOut ? "TOOL_TIMEOUT" : "INTERNAL",
      structuredOutput: {
        kind: "completed",
        exitCode: res.exitCode,
        signal: res.signal,
        timedOut: res.timedOut,
        truncated:
          res.stdout.includes("[truncated") || res.stderr.includes("[truncated"),
        classes,
        readOnly: readOnlyChain,
      },
      meta: {
        cmd: args.command,
        durMs: res.durMs,
        bytes: stdoutClean.length + stderrClean.length,
      },
    };
  },
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
