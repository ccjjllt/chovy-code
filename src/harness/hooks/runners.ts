/**
 * Hook runners — command spawn + function dynamic-import (step-13).
 *
 * Two runner flavours, matching `docs/step-13 §配置` `type` field:
 *   - `command`  — spawn the platform shell (PowerShell on Windows,
 *                  `/bin/bash -lc` on POSIX) with the hook's `command`.
 *   - `function` — `await import(path)` then call `module.default(ctx, payload)`.
 *
 * Both return a `RunnerResult`: the parsed `HookResult` plus the raw
 * stderr (so PreToolUse can surface warnings to the UI) and an outcome
 * tag for telemetry. Runners never throw — every failure path is folded
 * into a `bypass`/`error` outcome so the engine can keep going.
 *
 * Cross-platform shell selection mirrors `tools/exec/bash.ts`'s
 * `pickShell` but is reimplemented here (not imported) to avoid a
 * harness→tools dependency cycle — the hook layer must stay a leaf that
 * only reaches `node:child_process` + `safeFs` + `logger`.
 *
 * Timeout: per-hook `timeoutMs` (default 2000, cap 10000 per spec §风险).
 * On timeout the child is SIGTERM'd and the result is `outcome:"timeout"`.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { platform as osPlatform } from "node:os";

import { logger } from "../../logger/index.js";
import type {
  HookConfig,
  HookContext,
  HookPayload,
  HookResult,
} from "../../types/hook.js";
import { clampTimeout } from "./settings.js";

// ── Result ─────────────────────────────────────────────────────────────────

export type RunnerOutcome = "ok" | "blocked" | "bypassed" | "error" | "timeout";

export interface RunnerResult {
  /** Parsed `HookResult` from stdout (`undefined` when unparseable / empty). */
  result: HookResult;
  /** Raw stderr (PreToolUse surfaces this to the UI; others log it). */
  stderr: string;
  /** Raw stdout (debugging / telemetry). */
  stdout: string;
  /** Exit code from the command (null if it didn't run / timed out). */
  exitCode: number | null;
  /** Coarse outcome tag for telemetry. */
  outcome: RunnerOutcome;
  /** Wall-clock duration in milliseconds. */
  durMs: number;
}

// ── Shell selection (trimmed port of tools/exec/bash.ts pickShell) ─────────

interface ShellSpec {
  cmd: string;
  args: (script: string) => string[];
}

function pickShell(): ShellSpec {
  if (osPlatform() === "win32") {
    const override = process.env.CHOVY_BASH_SHELL?.toLowerCase();
    if (override === "cmd") {
      const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
      return { cmd: comspec, args: (s) => ["/d", "/s", "/c", s] };
    }
    const ps = override === "pwsh" ? "pwsh.exe" : "powershell.exe";
    return { cmd: ps, args: (s) => ["-NoProfile", "-NonInteractive", "-Command", s] };
  }
  return { cmd: "/bin/bash", args: (s) => ["-lc", s] };
}

// ── Payload → stdin JSON ───────────────────────────────────────────────────

/**
 * Build the JSON blob piped to the hook's stdin. Mirrors cc-haha's
 * `createBaseHookInput` shape (trimmed): the event name, session id, cwd,
 * and the tool-scoped fields when present. Hook authors read this via
 * `jq` or their language's stdin parser.
 */
export function buildHookInput(
  event: string,
  ctx: HookContext,
  payload: HookPayload,
): string {
  const input: Record<string, unknown> = {
    hook_event_name: event,
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
  };
  if (payload.toolName !== undefined) input["tool_name"] = payload.toolName;
  if (payload.toolArgs !== undefined) input["tool_input"] = payload.toolArgs;
  if (payload.result !== undefined) input["tool_response"] = payload.result;
  if (payload.error !== undefined) input["error"] = payload.error;
  if (payload.prompt !== undefined) input["prompt"] = payload.prompt;
  if (payload.extra) {
    for (const [k, v] of Object.entries(payload.extra)) input[k] = v;
  }
  return JSON.stringify(input);
}

// ── stdout → HookResult ────────────────────────────────────────────────────

/**
 * Parse hook stdout into a `HookResult`. Empty / non-JSON → `undefined`
 * (bypass). Valid JSON must be `{ok:true}` or `{ok:false,reason}`;
 * anything else → `undefined` + warn. This is the spec §返回值规约
 * contract: `{ok:true}` passes, `{ok:false,reason}` blocks, anything
 * else is "no opinion".
 */
export function parseHookResult(stdout: string): HookResult {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  if (!trimmed.startsWith("{")) {
    // Plain text stdout from a hook is treated as "no opinion" — the hook
    // ran but didn't speak the JSON protocol. Log for debugging.
    logger.debug("hook stdout was non-JSON (treated as bypass)", {
      stdout: trimmed.slice(0, 200),
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    logger.warn("hook stdout was malformed JSON (treated as bypass)", {
      stdout: trimmed.slice(0, 200),
    });
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as { ok?: unknown; reason?: unknown };
  if (obj.ok === true) return { ok: true };
  if (obj.ok === false && (typeof obj.reason === "string" || obj.reason === undefined)) {
    return { ok: false, reason: typeof obj.reason === "string" ? obj.reason : "hook blocked" };
  }
  logger.warn("hook JSON missing ok field (treated as bypass)", {
    stdout: trimmed.slice(0, 200),
  });
  return undefined;
}

/**
 * Parse a PermissionRequest hook's stdout for a decisive verdict. The
 * hook may emit either the plain `{ok:false,reason}` shape (→ deny) or
 * the richer `hookSpecificOutput.permissionDecision` shape cc-haha uses.
 * `{ok:true}` does NOT auto-allow (spec §竞速) — it returns `undefined`.
 */
export function parsePermissionDecision(stdout: string): {
  decision: import("../../types/hook.js").HookPermissionDecision;
  stderr: string;
} | null {
  const trimmed = stdout.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    ok?: unknown;
    reason?: unknown;
    hookSpecificOutput?: {
      permissionDecision?: unknown;
      permissionDecisionReason?: unknown;
      decision?: { behavior?: unknown; updatedInput?: unknown };
    };
  };

  // Rich shape: hookSpecificOutput.permissionDecision.
  const pd = obj.hookSpecificOutput?.permissionDecision;
  if (pd === "allow") return { decision: { behavior: "allow" }, stderr: "" };
  if (pd === "deny") {
    const reason =
      typeof obj.hookSpecificOutput?.permissionDecisionReason === "string"
        ? obj.hookSpecificOutput.permissionDecisionReason
        : typeof obj.reason === "string"
          ? obj.reason
          : "hook denied";
    return { decision: { behavior: "deny", reason }, stderr: "" };
  }
  // Rich shape: hookSpecificOutput.decision.behavior (cc-haha PermissionRequest).
  const dec = obj.hookSpecificOutput?.decision;
  if (dec && dec.behavior === "allow") return { decision: { behavior: "allow" }, stderr: "" };
  if (dec && dec.behavior === "deny") {
    const reason = typeof obj.reason === "string" ? obj.reason : "hook denied";
    return { decision: { behavior: "deny", reason }, stderr: "" };
  }
  // Plain shape: {ok:false} → deny. {ok:true} → NOT decisive (undefined).
  if (obj.ok === false) {
    const reason = typeof obj.reason === "string" ? obj.reason : "hook blocked";
    return { decision: { behavior: "deny", reason }, stderr: "" };
  }
  return null;
}

/**
 * Kill a child process and its whole tree. On Windows `child.kill(sig)`
 * only terminates the immediate process (often the shell), leaving the
 * real work process (e.g. `node` spawned by `powershell`) orphaned and
 * holding the stdio pipes open — so the `close` event never fires and the
 * timeout appears not to work. `taskkill /T /F /PID` kills the entire
 * tree; on POSIX `process.kill(-pid, sig)` signals the process group
 * (requires `detached: true` at spawn, set below).
 */
function killTree(child: { kill: (sig?: NodeJS.Signals) => boolean; pid?: number }): void {
  if (!child.pid) return;
  if (osPlatform() === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      /* fall through to plain kill */
    }
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

/**
 * Spawn the hook's command, pipe `stdinJson` on stdin, capture stdout/
 * stderr, enforce the timeout. Never throws — returns a `RunnerResult`
 * with the appropriate outcome tag.
 */
export function runCommandHook(
  hook: HookConfig,
  stdinJson: string,
  signal: AbortSignal,
): Promise<RunnerResult> {
  const command = hook.command!;
  const timeoutMs = clampTimeout(hook.timeoutMs);
  const { cmd, args } = pickShell();
  const t0 = Date.now();

  return new Promise<RunnerResult>((resolveFn) => {
    let child;
    try {
      child = spawn(cmd, args(command), {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // `detached: true` on POSIX puts the child in its own process
        // group so `killTree` can signal the whole group. On Windows we
        // rely on `taskkill /T` instead (detached would create a console).
        detached: osPlatform() !== "win32",
      });
    } catch (err) {
      resolveFn({
        result: undefined,
        stderr: err instanceof Error ? err.message : String(err),
        stdout: "",
        exitCode: null,
        outcome: "error",
        durMs: Date.now() - t0,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (r: Omit<RunnerResult, "durMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveFn({ ...r, durMs: Date.now() - t0 });
    };

    const onAbort = () => {
      killTree(child);
    };
    signal.addEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer | string) =>
      stdoutChunks.push(typeof c === "string" ? Buffer.from(c) : c),
    );
    child.stderr?.on("data", (c: Buffer | string) =>
      stderrChunks.push(typeof c === "string" ? Buffer.from(c) : c),
    );

    child.on("error", (err) => {
      finish({
        result: undefined,
        stderr: err.message,
        stdout: "",
        exitCode: null,
        outcome: "error",
      });
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        finish({ result: undefined, stderr, stdout, exitCode: code, outcome: "timeout" });
        return;
      }
      // Exit 0 required (spec §返回值规约); non-zero → bypass + warn.
      if (code !== 0) {
        logger.warn("hook command exited non-zero (treated as bypass)", {
          command: command.slice(0, 120),
          exitCode: code,
        });
        finish({ result: undefined, stderr, stdout, exitCode: code, outcome: "bypassed" });
        return;
      }
      const result = parseHookResult(stdout);
      const outcome: RunnerOutcome =
        result && result.ok === false ? "blocked" : "ok";
      finish({ result, stderr, stdout, exitCode: code, outcome });
    });

    // Pipe stdin then close it so the hook can read the full payload.
    try {
      child.stdin?.write(stdinJson, "utf8");
      child.stdin?.end();
    } catch (err) {
      // If stdin write fails we still let the hook run; it may not need
      // stdin. Log for debugging.
      logger.debug("hook stdin write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      try { child.stdin?.end(); } catch { /* ignore */ }
    }
  });
}

// ── Function runner ────────────────────────────────────────────────────────

/**
 * Dynamic-import the hook's ESM module and call its default export. The
 * default export signature is `(ctx, payload) => HookResult | Promise<HookResult>`.
 * Path is resolved relative to cwd. Errors → bypass outcome + warn.
 *
 * Function hooks let programmatic users (e.g. a plugin) register logic
 * without spawning a process; they're gated by trust just like command
 * hooks (an untrusted cwd refuses them too — arbitrary code is arbitrary
 * code).
 */
export async function runFunctionHook(
  hook: HookConfig,
  ctx: HookContext,
  payload: HookPayload,
  signal: AbortSignal,
): Promise<RunnerResult> {
  const t0 = Date.now();
  const timeoutMs = clampTimeout(hook.timeoutMs);
  const absPath = resolve(process.cwd(), hook.path!);

  // Race the import+call against the timeout. Unlike the command runner
  // we can't SIGTERM a function, so the timeout just resolves the race
  // winner — the function may continue running in the background (we
  // can't forcibly cancel a Promise in JS). The outcome is "timeout" and
  // the engine treats it as bypass.
  let timedOut = false;
  const timer = new Promise<"timeout">((r) => {
    setTimeout(() => {
      timedOut = true;
      r("timeout");
    }, timeoutMs);
  });

  const exec = (async () => {
    const mod = await import(absPath);
    const fn = mod?.default;
    if (typeof fn !== "function") {
      throw new Error(`hook module "${absPath}" has no default export function`);
    }
    return await fn(ctx, payload);
  })();

  try {
    const winner = await Promise.race([exec, timer]);
    if (winner === "timeout" || timedOut) {
      return {
        result: undefined,
        stderr: `function hook timed out after ${timeoutMs}ms`,
        stdout: "",
        exitCode: null,
        outcome: "timeout",
        durMs: Date.now() - t0,
      };
    }
    // `winner` is the function's return value.
    const ret = winner as HookResult;
    // If the function returned a structured HookResult, honor it; else bypass.
    if (ret && typeof ret === "object" && "ok" in ret) {
      const outcome: RunnerOutcome = ret.ok === false ? "blocked" : "ok";
      return {
        result: ret,
        stderr: "",
        stdout: "",
        exitCode: 0,
        outcome,
        durMs: Date.now() - t0,
      };
    }
    // No structured return → bypass (function had no opinion).
    return {
      result: undefined,
      stderr: "",
      stdout: "",
      exitCode: 0,
      outcome: "bypassed",
      durMs: Date.now() - t0,
    };
  } catch (err) {
    logger.warn("function hook threw (treated as bypass)", {
      path: absPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      result: undefined,
      stderr: err instanceof Error ? err.message : String(err),
      stdout: "",
      exitCode: null,
      outcome: "error",
      durMs: Date.now() - t0,
    };
  } finally {
    // signal honored indirectly: if aborted, the import/call will reject
    // on the next tick for most real-world modules. We can't cancel an
    // in-flight Promise, but we record that we observed the signal.
    void signal;
  }
}
