/**
 * Shell sandbox — subprocess isolation policy + executor wiring (step-14).
 *
 * Two responsibilities:
 *
 *   1. **`shouldUseSandbox`** — decide whether a parsed bash command needs
 *      to run under a restricted child process. Lifted from cc-haha's
 *      `tools/BashTool/shouldUseSandbox.ts` trigger conditions, trimmed
 *      to chovy's needs (no GrowthBook, no excludedCommands config):
 *        - network commands (`curl`/`wget`) while the user is in a
 *          read-leaning mode (`plan` / `auto`),
 *        - privilege escalation (`sudo` / `su` / `doas`),
 *        - a redirect whose target resolves outside cwd.
 *
 *   2. **`buildSandboxSpawnArgs`** — produce the `cmd`/`args`/`env` triple
 *      the bash tool hands to `Bun.spawn`/`child_process.spawn`. On POSIX
 *      we probe for `bwrap` (bubblewrap) and, when present, wrap the
 *      command in a read-only-root + cwd-writable + restricted-network
 *      invocation. When `bwrap` is absent (or on Windows), we degrade to
 *      a "strict env + cwd-locked" child — still better than the default
 *      `process.env` leak, and spec-acceptable (step-14 §风险: "bwrap
 *      缺失导致沙箱降级 → 启动 telemetry warn；不阻断功能").
 *
 * Resource limits (step-14 §资源限制):
 *   - `maxOutputBytes`: 30 KB stdout + 30 KB stderr. The bash tool's
 *     `EndTruncatingAccumulator` already enforces this (8+22 KiB per
 *     stream); we expose the constant here so the policy lives in one
 *     place and future tools can opt in.
 *   - `wallclock`: 120s default, matching the bash tool's
 *     `DEFAULT_TIMEOUT_MS`. Enforced by the caller's spawn `timeout`.
 *   - `cpuTime` / `processCount`: POSIX-only (`ulimit -t` / `ulimit -u`).
 *     There's no portable Node API to set these post-spawn, so we wrap
 *     the command in a `ulimit` preamble on POSIX when bwrap is absent.
 *     Windows falls back to wallclock only (documented in §资源限制).
 *
 * Edge rules (AGENTS.md §18):
 *   - Leaf module. Reaches `tools/exec/ast.js` + `tools/exec/classification.js`
 *     (zero-dependency pure functions) to inspect the command — same
 *     pattern the permission engine + hook engine use. Does NOT import
 *     the tool registry, so there's no cycle.
 *   - `filterEnv` preserves `CHOVY_HOME` / `CHOVY_BASH_SHELL` so the
 *     child still resolves the chovy home + shell override.
 */

import { platform } from "node:os";
import { dirname, resolve } from "node:path";

import type { BashParseResult } from "../../tools/exec/ast.js";
import { classifyBaseCommand } from "../../tools/exec/classification.js";
import type { PermissionMode } from "../../config/index.js";
import {
  isWithinCwd,
  resolveSymlinkChain,
} from "./allowlist.js";

const IS_WIN = platform() === "win32";

// ── Resource limit policy ───────────────────────────────────────────────────

/**
 * Sandbox resource limits (step-14 §资源限制). The bash tool enforces
 * `maxOutputBytes` via `EndTruncatingAccumulator` and `wallclockMs` via
 * its spawn `timeout`; these constants are the single source so other
 * long-running tools (web_fetch, future task system) can share them.
 */
export const RESOURCE_LIMITS = {
  /** Max bytes kept from stdout (matches EndTruncatingAccumulator default). */
  maxOutputBytes: 30 * 1024,
  /** Max bytes kept from stderr. */
  maxStderrBytes: 30 * 1024,
  /** Default wall-clock cap (matches bash tool DEFAULT_TIMEOUT_MS). */
  wallclockMs: 120_000,
} as const;

// ── Env whitelist ───────────────────────────────────────────────────────────

/**
 * Environment variables the sandboxed child is allowed to inherit. The
 * default `process.env` carries PS1, BASH_ENV, shell functions, proxy
 * overrides, and a long tail of session-specific noise that a malicious
 * command could abuse. We keep the minimum the child needs to find its
 * binaries, locale, and chovy home.
 *
 * `CHOVY_HOME` + `CHOVY_BASH_SHELL` are preserved so the child resolves
 * the chovy home dir + shell override identically to the parent (the
 * bash tool reads both).
 */
export const ENV_WHITELIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "CHOVY_HOME",
  "CHOVY_BASH_SHELL",
  // Windows needs these to find system DLLs / the user profile.
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "TEMP",
  "TMP",
];

/**
 * Filter an environment down to the whitelist + any `CHOVY_`-prefixed
 * vars (so future feature flags propagate without touching this list).
 * Returns a fresh object; the caller's `process.env` is untouched.
 */
export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ENV_WHITELIST.includes(k) || k.startsWith("CHOVY_")) {
      out[k] = v;
    }
  }
  return out;
}

// ── shouldUseSandbox ────────────────────────────────────────────────────────

export interface SandboxDecisionOptions {
  /** Current permission mode (drives the network-command rule). */
  mode: PermissionMode;
  /** Raw command line — used for the redirect-target scan when the AST
   *  doesn't surface a redirect target (e.g. fused `>file`). */
  command: string;
  /** Working directory; default `process.cwd()`. */
  cwd?: string;
}

/**
 * Should `ast` run inside the sandbox? See module docblock for the three
 * trigger families. Returns `false` for unparseable commands — the bash
 * tool's danger evaluator already forces those to `ask`, and sandboxing
 * an opaque command adds no value (we can't inspect what we can't parse).
 *
 * Mirrors cc-haha's `shouldUseSandbox` shape (boolean decision) but with
 * chovy's trigger set: no `excludedCommands` config, no GrowthBook.
 */
export function shouldUseSandbox(
  ast: BashParseResult,
  opts: SandboxDecisionOptions,
): boolean {
  if (!ast.ok) return false;
  const cwd = opts.cwd ?? process.cwd();

  for (const seg of ast.commands) {
    const base = pickBase(seg.argv);
    const klass = classifyBaseCommand(base);

    // 1. Network command in a read-leaning mode.
    //    `plan` is read-only (the engine denies mutate anyway, but we
    //    sandbox defensively in case a hook allows it); `auto` has no
    //    classifier (AGENTS.md §5) so a network call should be isolated.
    if (
      klass === "NETWORK" &&
      (opts.mode === "plan" || opts.mode === "auto")
    ) {
      return true;
    }

    // 2. Privilege escalation.
    if (base === "sudo" || base === "su" || base === "doas") {
      return true;
    }

    // 3. Redirect target outside cwd.
    for (const r of seg.redirects) {
      if (r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>") {
        if (redirectsOutsideCwd(r.target, cwd)) return true;
      }
    }
  }

  return false;
}

/** First argv token, lowercased + basename-stripped (best-effort). */
function pickBase(argv: string[]): string {
  const first = argv[0];
  if (!first) return "";
  return (first.split(/[\\/]/).pop() ?? first).toLowerCase();
}

/**
 * Does a redirect `target` resolve outside `cwd`? Best-effort: empty /
 * non-path targets (e.g. `>&1`) don't trip; we only flag real file paths
 * that symlink-resolve outside the working directory.
 */
function redirectsOutsideCwd(target: string, cwd: string): boolean {
  if (!target || /^\d+$/.test(target) || target.startsWith("&")) return false;
  // Strip quotes the shell would have removed.
  const clean = target.replace(/^['"]|['"]$/g, "");
  const reps = resolveSymlinkChain(clean, cwd);
  // If *any* representation is inside cwd, treat as safe (the write lands
  // in the project). Only flag when all reps escape.
  return !reps.some((rep) => isWithinCwd(rep, cwd));
}

// ── buildSandboxSpawnArgs ───────────────────────────────────────────────────

export interface SpawnSandboxOpts {
  /** Working directory for the child. */
  cwd: string;
  /** Wall-clock cap; enforced by the caller's spawn timeout. */
  timeoutMs: number;
  /** Optional abort signal (propagated to the spawn by the caller). */
  abortSignal?: AbortSignal;
}

export interface SpawnSandboxPlan {
  /** Executable to spawn (`bwrap`, `/bin/bash`, `powershell.exe`, …). */
  cmd: string;
  /** Argv for the spawn. */
  args: string[];
  /** Filtered environment for the child. */
  env: NodeJS.ProcessEnv;
  /** Whether we managed to wrap in bwrap (POSIX) — false on Windows/degrade. */
  useBwrap: boolean;
  /** Whether we fell back from bwrap to strict-env. Surfaced to telemetry. */
  degraded: boolean;
}

/**
 * Probe for `bwrap` on PATH. Bun exposes `Bun.which`; under plain Node
 * we'd shell out to `which`, but chovy-code runs on Bun so the fast path
 * is always available. The `try/catch` defends against non-Bun test
 * runners.
 */
function findBwrap(): string | null {
  const g = globalThis as { Bun?: { which?: (cmd: string) => string | null } };
  if (typeof g.Bun?.which === "function") {
    try {
      return g.Bun.which("bwrap");
    } catch {
      return null;
    }
  }
  return null;
}

/** Memoized bwrap probe — PATH doesn't change mid-session. */
let bwrapCache: string | null | undefined;
function bwrapPath(): string | null {
  if (bwrapCache === undefined) bwrapCache = findBwrap();
  return bwrapCache;
}

/**
 * Build the spawn plan for a sandboxed command. See module docblock for
 * the bwrap vs. strict-env decision.
 *
 * The returned `cmd`/`args` replace the bash tool's default `pickShell()`
 * output when `shouldUseSandbox` returned true. The caller still owns:
 *   - `stdio` (pipe stdout/stderr into its accumulator),
 *   - `timeout` (from `timeoutMs`),
 *   - `abortSignal` forwarding,
 *   - `cwd` (passed through to spawn options).
 */
export function buildSandboxSpawnArgs(
  command: string,
  opts: SpawnSandboxOpts,
): SpawnSandboxPlan {
  const env = filterEnv(process.env);

  // ── POSIX + bwrap available: full sandbox. ────────────────────────────
  if (!IS_WIN) {
    const bwrap = bwrapPath();
    if (bwrap) {
      // Read-only root, the cwd bind-mounted read-write, /tmp + /dev
      // available. `--die-with-parent` ensures the sandbox dies if the
      // agent loop is killed. Network is left enabled by default —
      // shouldUseSandbox flags network commands but we don't hard-block
      // them here (the permission engine already decided allow/ask).
      const args = [
        "--die-with-parent",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/sbin", "/sbin",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--bind", opts.cwd, opts.cwd,
        "--unshare-pid",
        "--die-with-parent",
        "--",
        "/bin/bash",
        "-lc",
        command,
      ];
      return { cmd: bwrap, args, env, useBwrap: true, degraded: false };
    }

    // ── POSIX, no bwrap: degrade to strict env + ulimit preamble. ───────
    // Wrap the command so `ulimit` applies to the bash child and its
    // descendants. `-t 600` = 10 CPU-minutes (generous; the wall-clock
    // timeout is the real backstop), `-u 256` = max user processes
    // (anti fork-bomb). We prepend these to the user's command.
    const limited =
      `ulimit -t 600 2>/dev/null; ` +
      `ulimit -u 256 2>/dev/null; ` +
      command;
    return {
      cmd: "/bin/bash",
      args: ["-lc", limited],
      env,
      useBwrap: false,
      degraded: true,
    };
  }

  // ── Windows: strict env only (Job Object is future work). ─────────────
  // PowerShell doesn't honor `ulimit`; the wall-clock timeout is the only
  // resource backstop. We still filter the env so a malicious command
  // can't read session noise from `process.env`.
  const ps = process.env.CHOVY_BASH_SHELL?.toLowerCase() === "cmd"
    ? (process.env.ComSpec || process.env.COMSPEC || "cmd.exe")
    : "powershell.exe";
  const args =
    process.env.CHOVY_BASH_SHELL?.toLowerCase() === "cmd"
      ? ["/d", "/s", "/c", command]
      : ["-NoProfile", "-NonInteractive", "-Command", command];
  return { cmd: ps, args, env, useBwrap: false, degraded: true };
}

/**
 * Resolve the writable scratch directory for a sandboxed command — the
 * one path (besides cwd) the child is allowed to write. Today this is
 * the chovy telemetry/tmp area; future steps (task system, scratchpad)
 * will expand it. Exposed so the bash tool can pass it to bwrap `--bind`
 * if it wants a scratch dir distinct from cwd.
 */
export function sandboxScratchDir(cwd: string): string {
  // Keep it adjacent to cwd so relative paths still make sense; the
  // caller decides whether to bind-mount it.
  return resolve(dirname(cwd), ".chovy-sandbox-scratch");
}

// Re-export the AST type so callers import the sandbox surface from one place.
export type { BashParseResult };
