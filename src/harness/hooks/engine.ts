/**
 * Hook engine — main scheduler (step-13).
 *
 * Owns the in-memory snapshot, dispatches events to matching hooks, and
 * runs the PermissionRequest race. Exposed on `ToolContext.hooks` (the
 * step-06-frozen `HookEngine` interface) by the agent loop; the
 * permission engine's L5 calls `runPermissionRequest` to race the user
 * prompt.
 *
 * Key invariants (spec §竞速 + §返回值规约):
 *   - `{ok:true}` is NOT decisive — it folds into `allow` for advisory
 *     events but does NOT auto-approve a permission request.
 *   - Only `{ok:false}` (deny) or an explicit PermissionRequest allow
 *     decision short-circuits the L6 user prompt.
 *   - Hook errors / timeouts / non-zero exits → bypass (no opinion) +
 *     telemetry; the agent loop is never broken by a misbehaving hook.
 *   - User/project hooks are gated by `trust.ts`: an untrusted cwd only
 *     runs `managed:true` hooks (chovy built-ins).
 *
 * Telemetry: the engine is the SINGLE emitter of `hook.run` events (§17
 * `tool.call` invariant mirrored here) — runners MUST NOT emit.
 */

import { logger } from "../../logger/index.js";
import { emitTelemetry } from "../../telemetry/index.js";
import type {
  HookConfig,
  HookContext,
  HookOutcome,
  HookPayload,
  HookPermissionDecision,
} from "../../types/hook.js";

import {
  captureSnapshot,
  hasHookForEvent,
  type HookSnapshot,
} from "./snapshot.js";
import {
  compileMatcher,
  hookContentFor,
  matchesHook,
} from "./settings.js";
import { shouldAllowManagedHooksOnly } from "./trust.js";
import {
  buildHookInput,
  parsePermissionDecision,
  runCommandHook,
  runFunctionHook,
  type RunnerResult,
} from "./runners.js";

// ── Engine ─────────────────────────────────────────────────────────────────

export interface HookEngineOptions {
  cwd: string;
  sessionId: string;
  /** Settings paths; defaults to user + project settings.json. */
  settingsPaths?: string[];
  /**
   * Pre-captured snapshot (tests / managed hooks). When set, `settingsPaths`
   * is ignored. Use `captureSnapshotFromText` / `captureSnapshotFromHooks`
   * to build one.
   */
  snapshot?: HookSnapshot;
  /**
   * Override the trust check (tests). When false, user hooks are refused
   * regardless of `~/.chovy/trust.json`. Defaults to the real trust state.
   */
  trusted?: boolean;
}

/**
 * The live hook engine. Constructed once per session (or per sub-agent —
 * each gets its own snapshot + own AbortController per AGENTS.md §9).
 */
export interface HookEngineInternal {
  /** Frozen settings snapshot for the session. */
  snapshot: HookSnapshot;
  /** Resolved trust state at construction time. */
  trusted: boolean;
  /** Shared abort controller for the session; runners derive per-hook signals. */
  abortController: AbortController;
  cwd: string;
  sessionId: string;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Construct a hook engine. Captures the settings snapshot at construction
 * time (SessionStart) — later edits to `settings.json` don't take effect
 * until the next session (spec §启动快照). The returned object exposes
 * `emit` / `runPermissionRequest` matching the frozen `HookEngine`
 * interface on `ToolContext.hooks`.
 */
export function createHookEngine(opts: HookEngineOptions): {
  emit: (event: string, payload: unknown) => Promise<HookOutcome>;
  runPermissionRequest: (
    toolName: string,
    args: unknown,
    ctx: HookContext,
  ) => Promise<HookPermissionDecision>;
  internal: HookEngineInternal;
} {
  const snapshot =
    opts.snapshot ??
    captureSnapshot({ cwd: opts.cwd, paths: opts.settingsPaths });
  const trusted = opts.trusted ?? !shouldAllowManagedHooksOnly(opts.cwd);
  const abortController = new AbortController();

  if (snapshot.hooks.length > 0) {
    logger.debug("hook engine initialized", {
      hooks: snapshot.hooks.length,
      events: new Set(snapshot.hooks.map((h) => h.event)).size,
      trusted,
    });
  }

  const internal: HookEngineInternal = {
    snapshot,
    trusted,
    abortController,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
  };

  return {
    emit: (event, payload) => emitImpl(internal, event, payload),
    runPermissionRequest: (toolName, args, ctx) =>
      runPermissionRequestImpl(internal, toolName, args, ctx),
    internal,
  };
}

// ── Emit (advisory events) ─────────────────────────────────────────────────

/**
 * Run all hooks matching `event`. Returns the aggregated outcome:
 *   - `block` if any hook returned `{ok:false,reason}` (first blocker
 *     wins; remaining hooks still run for telemetry but their results
 *     are logged, not acted on).
 *   - `allow` if all matching hooks ran and none blocked.
 *   - `bypass` if no hook ran (none configured / trust-gated).
 *
 * Never throws — hook errors are swallowed + logged. The agent loop
 * relies on this so a bad hook can't crash the session.
 */
async function emitImpl(
  eng: HookEngineInternal,
  event: string,
  payload: unknown,
): Promise<HookOutcome> {
  if (!hasHookForEvent(eng.snapshot, event)) {
    return { type: "bypass" };
  }

  const p = (payload ?? {}) as HookPayload;
  const ctx: HookContext = {
    event: event as HookContext["event"],
    cwd: eng.cwd,
    sessionId: eng.sessionId,
    signal: eng.abortController.signal,
  };

  const toolName = p.toolName;
  const content = hookContentFor(toolName, p.toolArgs);

  let blocked: { reason: string } | null = null;
  let anyOpinionated = false;

  for (const hook of eng.snapshot.hooks) {
    if (hook.event !== event) continue;
    if (!hookMatches(hook, toolName, content)) continue;
    if (!hookAllowedByTrust(hook, eng.trusted)) {
      emitHookTelemetry(event, hook, "bypassed", 0);
      continue;
    }
    const res = await runOne(hook, event, ctx, p);
    // A hook that produced a parsed result (`ok` / `blocked`) had an
    // opinion. Timeouts / errors / non-zero exits / empty stdout are
    // "no opinion" → bypass (spec §返回值规约). They still ran (telemetry
    // records it) but don't flip the outcome to `allow`.
    if (res.outcome === "ok" || res.outcome === "blocked") {
      anyOpinionated = true;
    }
    if (res.outcome === "blocked" && !blocked) {
      blocked = { reason: res.result && res.result.ok === false ? res.result.reason : "hook blocked" };
    }
    // Surface PreToolUse stderr to the UI via the logger (the agent loop
    // can also install an onHookMessage callback — wired in step-22). For
    // now stderr goes to the debug log so it isn't lost.
    if (res.stderr && res.stderr.trim().length > 0) {
      logger.info(`hook ${event} stderr`, {
        hook: describeHook(hook),
        stderr: res.stderr.slice(0, 500),
      });
    }
  }

  if (blocked) return { type: "block", reason: blocked.reason };
  if (anyOpinionated) return { type: "allow" };
  return { type: "bypass" };
}

// ── PermissionRequest (decisive race) ──────────────────────────────────────

/**
 * Race the user permission prompt against PermissionRequest hooks.
 * Returns the first decisive `allow` / `deny`; `undefined` if no hook
 * decided (bypass → falls through to L6). Per spec §竞速: `{ok:true}` is
 * NOT decisive — only an explicit deny or explicit allow wins.
 *
 * The "race" today is single-lane (no user prompt wired until step-22, no
 * classifier per AGENTS.md §5): the first decisive hook wins. When
 * step-22 lands, the agent loop will `Promise.race` this against
 * `ctx.askUser`; the spec's literal `Promise.race` shape is preserved by
 * having this function resolve to a decisive verdict or `undefined`.
 */
async function runPermissionRequestImpl(
  eng: HookEngineInternal,
  toolName: string,
  args: unknown,
  ctx: HookContext,
): Promise<HookPermissionDecision> {
  if (!hasHookForEvent(eng.snapshot, "PermissionRequest")) {
    return undefined;
  }
  const content = hookContentFor(toolName, args);
  const payload: HookPayload = { toolName, toolArgs: args };

  for (const hook of eng.snapshot.hooks) {
    if (hook.event !== "PermissionRequest") continue;
    if (!hookMatches(hook, toolName, content)) continue;
    if (!hookAllowedByTrust(hook, eng.trusted)) {
      emitHookTelemetry("PermissionRequest", hook, "bypassed", 0);
      continue;
    }
    const res = await runOne(hook, "PermissionRequest", ctx, payload);

    // For PermissionRequest, parse stdout for the decisive verdict
    // (handles both {ok:false} and hookSpecificOutput.permissionDecision).
    if (res.outcome === "ok" || res.outcome === "blocked") {
      const parsed = parsePermissionDecision(res.stdout);
      if (parsed?.decision) {
        emitHookTelemetry(
          "PermissionRequest",
          hook,
          parsed.decision.behavior === "allow" ? "ok" : "blocked",
          res.durMs,
        );
        return parsed.decision;
      }
    }
    // No decisive verdict from this hook → keep racing the next one.
  }
  return undefined;
}

// ── Per-hook execution ─────────────────────────────────────────────────────

/**
 * Run a single hook via the appropriate runner. Each hook gets its own
 * AbortSignal derived from the session controller so a session cancel
 * tears down in-flight hooks. Returns a `RunnerResult` (never throws).
 */
async function runOne(
  hook: HookConfig,
  event: string,
  ctx: HookContext,
  payload: HookPayload,
): Promise<RunnerResult> {
  const hookSignal = ctx.signal;
  try {
    if (hook.type === "command") {
      const stdinJson = buildHookInput(event, ctx, payload);
      const res = await runCommandHook(hook, stdinJson, hookSignal);
      emitHookTelemetry(event, hook, res.outcome, res.durMs);
      return res;
    }
    // type === "function"
    const res = await runFunctionHook(hook, ctx, payload, hookSignal);
    emitHookTelemetry(event, hook, res.outcome, res.durMs);
    return res;
  } catch (err) {
    // Defensive: runners don't throw, but a future runner might. Treat
    // any escape as a bypass so the engine keeps going.
    logger.warn("hook runner threw unexpectedly", {
      hook: describeHook(hook),
      error: err instanceof Error ? err.message : String(err),
    });
    const res: RunnerResult = {
      result: undefined,
      stderr: err instanceof Error ? err.message : String(err),
      stdout: "",
      exitCode: null,
      outcome: "error",
      durMs: 0,
    };
    emitHookTelemetry(event, hook, "error", 0);
    return res;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Does `hook`'s matcher apply to `(toolName, content)`? */
function hookMatches(
  hook: HookConfig,
  toolName: string | undefined,
  content: string,
): boolean {
  const matcher = compileMatcher(hook.matcher);
  return matchesHook(matcher, toolName, content);
}

/** Trust gate: managed hooks always run; user hooks need a trusted cwd. */
function hookAllowedByTrust(hook: HookConfig, trusted: boolean): boolean {
  if (hook.managed === true) return true;
  return trusted;
}

/** Emit a `hook.run` telemetry event (single source — this module). */
function emitHookTelemetry(
  event: string,
  hook: HookConfig,
  outcome: RunnerResult["outcome"],
  durMs: number,
): void {
  emitTelemetry({
    type: "hook.run",
    event,
    hookName: describeHook(hook),
    outcome,
    durMs,
  });
}

/** Human-readable hook label for telemetry / logs. */
export function describeHook(hook: HookConfig): string {
  const target =
    hook.type === "command"
      ? (hook.command ?? "").slice(0, 80)
      : hook.path ?? "<fn>";
  return `${hook.event}${hook.matcher ? `(${hook.matcher})` : ""}:${hook.type}:${target}`;
}

// ── Re-exports for callers / tests ─────────────────────────────────────────

export {
  captureSnapshot,
  captureSnapshotFromText,
  captureSnapshotFromHooks,
  hasHookForEvent,
  type HookSnapshot,
} from "./snapshot.js";
export {
  compileMatcher,
  matchesHook,
  hookContentFor,
  defaultSettingsPaths,
  loadSettingsFromPaths,
  loadSettingsFromText,
  clampTimeout,
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_TIMEOUT_MS,
  TOOL_SCOPED_EVENTS,
  type CompiledMatcher,
  type SettingsFile,
} from "./settings.js";
export {
  isTrusted,
  markTrusted,
  revokeTrust,
  shouldAllowManagedHooksOnly,
  normalizeCwdKey,
  trustFilePath,
} from "./trust.js";
export {
  buildHookInput,
  parseHookResult,
  parsePermissionDecision,
  runCommandHook,
  runFunctionHook,
  type RunnerResult,
  type RunnerOutcome,
} from "./runners.js";
