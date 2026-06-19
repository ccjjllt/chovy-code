/**
 * Hook engine contracts (step-13 — frozen).
 *
 * The canonical `HookEvent` union + `HookEngine` interface are frozen here
 * (architecture.md §3.3 freezes `HookEvent` / `HookHandler` at step-13).
 * `src/harness/hooks/` implements the runtime; consumers reach it through
 * `ToolContext.hooks: HookEngine` (frozen at step-06, extended here by
 * adding the optional `runPermissionRequest` handle — the `emit` field
 * name is unchanged per AGENTS.md §18).
 *
 * Hooks are user/project-supplied commands or functions that fire at 12
 * well-defined lifecycle points. Most events are *advisory* (fire-and-
 * forget, output logged); only `PreToolUse` can block a tool call and
 * only `PermissionRequest` produces a decisive allow/deny that races the
 * user prompt (spec §竞速).
 */
import type { ChatMessage } from "./messages.js";

/**
 * The 12+1 hook event types (step-13 + step-28 extension).
 *
 * 8 mirror cc-haha's event surface; 3 (`GoalIteration` / `SubAgentSpawn` /
 * `CheckpointWritten`) are chovy-code additions wired to chovy's own
 * long-running-task / sub-agent / memory checkpoints. `ContextRebuilt`
 * (step-28) fires after the SCW rebuilder swaps the message tail —
 * advisory only, mirrors the §17 rule that hooks observe but never
 * mutate the rebuilt list.
 *
 * Frozen here as the single source — `harness/hooks/` re-exports it.
 * Adding members is the explicit extension model (AGENTS.md §16
 * "frozen-extension"); renaming is forbidden.
 */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "PermissionDenied"
  | "Notification"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "GoalIteration"
  | "SubAgentSpawn"
  | "CheckpointWritten"
  | "ContextRebuilt";

/**
 * Outcome of running *all* hooks for a single event (spec §返回值规约).
 *
 * - `allow`   → no objection; the action proceeds.
 * - `block`   → a hook returned `{ok:false,reason}`; `reason` is surfaced
 *               to the model / UI and the action is short-circuited.
 * - `bypass`  → no hook ran (none configured / trust denied / timeout /
 *               non-zero exit) — treated as "no opinion", the action
 *               proceeds. The engine still records telemetry.
 *
 * `{ok:true}` from a hook is NOT decisive (spec §竞速): it is folded into
 * `allow` for advisory events but does NOT auto-approve a permission
 * request — only an explicit PermissionRequest decision does that.
 */
export type HookOutcome =
  | { type: "allow" }
  | { type: "block"; reason: string }
  | { type: "bypass" };

/**
 * Raw return value a hook's stdout is parsed into (spec §返回值规约).
 *
 * - `{ok:true}`                 → advisory pass.
 * - `{ok:false, reason}`        → block (PreToolUse) / decisive deny
 *                                  (PermissionRequest).
 * - `undefined` (no stdout)     → bypass.
 *
 * Malformed JSON / non-zero exit / timeout → `undefined` (bypass) + warn.
 */
export type HookResult =
  | { ok: true }
  | { ok: false; reason: string }
  | undefined;

/**
 * Decisive verdict from a `PermissionRequest` hook (spec §竞速).
 *
 * Only `allow` / `deny` are decisive and short-circuit L6; `undefined`
 * (bypass) falls through to the user prompt. `{ok:true}` from a
 * PermissionRequest hook is parsed as `undefined` — it does NOT auto-allow
 * (a hook that wants to allow must emit the explicit decision shape).
 */
export type HookPermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | undefined;

/** Context handed to the engine for each event; forwarded to runners. */
export interface HookContext {
  event: HookEvent;
  /** Working directory the agent runs in. */
  cwd: string;
  /** Session id (agentId). */
  sessionId: string;
  /** Abort signal — runners MUST honor it (cancellation / timeout). */
  signal: AbortSignal;
}

/**
 * Payload for tool-related events. `toolName`/`args` are present for
 * PreToolUse / PostToolUse / PermissionRequest; `result` for PostToolUse.
 */
export interface HookPayload {
  /** Tool name; present for tool-scoped events. */
  toolName?: string;
  /** Tool args; present for PreToolUse / PermissionRequest. */
  toolArgs?: unknown;
  /** Tool result text; present for PostToolUse / PostToolUseFailure. */
  result?: string;
  /** Error message; present for PostToolUseFailure. */
  error?: string;
  /** User prompt text; present for UserPromptSubmit. */
  prompt?: string;
  /** Free-form extra fields the engine forwards verbatim. */
  extra?: Record<string, unknown>;
}

/**
 * A single hook configuration entry (parsed from `settings.json`).
 *
 * `matcher` selects which tool invocations a tool-scoped hook fires for:
 *   - `"*"`           → all tools.
 *   - `"bash"`        → exact tool name.
 *   - `"bash(*rm*)"`  → wildcard over the tool's content (command / path).
 *
 * `type: "command"` spawns the platform shell; `type: "function"` dynamic-
 * imports an ESM module and calls its default export.
 */
export interface HookConfig {
  event: HookEvent;
  matcher?: string;
  type: "command" | "function";
  /** For `type:"command"`: the shell command string. */
  command?: string;
  /** For `type:"function"`: absolute path to an ESM module. */
  path?: string;
  /** Per-hook timeout; defaults to 2000ms, hard cap 10000ms (spec §风险). */
  timeoutMs?: number;
  /**
   * When true this hook is chovy-managed (built-in) and runs even in
   * untrusted workspaces. User/project hooks from settings.json are
   * `managed: false` (default) and gated by `shouldAllowManagedHooksOnly`.
   */
  managed?: boolean;
}

/**
 * Hook engine handle exposed on `ToolContext.hooks` (step-06 froze the
 * `emit` field name; step-13 adds the optional `runPermissionRequest`
 * handle — adding optional fields is permitted, renaming is not).
 *
 * The agent loop constructs a real `HookEngine` (see
 * `src/harness/hooks/engine.ts`) and injects it; the permission engine's
 * L5 calls `runPermissionRequest` to race the user prompt.
 */
export interface HookEngine {
  /**
   * Fire an advisory event (PreToolUse / PostToolUse / SessionStart / …).
   * Resolves once all matching hooks have run (or bypassed). Never throws
   * — hook errors are swallowed + logged so a misbehaving hook can't
   * break the agent loop. Returns the aggregated outcome so callers can
   * react to a `block` (PreToolUse) without a second round-trip.
   */
  emit?(event: string, payload: unknown): Promise<HookOutcome>;

  /**
   * step-13: race the user permission prompt. Returns a decisive
   * `allow` / `deny` if any matching hook produced one (first decisive
   * wins); `undefined` (bypass) if no hook decided. The permission engine
   * calls this at L5 — a decisive result short-circuits L6.
   */
  runPermissionRequest?(
    toolName: string,
    args: unknown,
    ctx: HookContext,
  ): Promise<HookPermissionDecision>;
}

// ── Deprecated draft surface (step-01 draft; kept compiling via barrel) ─────

/**
 * @deprecated Use `HookOutcome` instead. The step-01 draft modeled a
 * `modify` outcome that mutated the message list; step-13 collapses to
 * allow/block/bypass — message mutation belongs to the SCW rebuilder
 * (step-28), not the hook engine.
 */
export type LegacyHookOutcome = HookOutcome;

/**
 * @deprecated Use `HookContext` instead. The step-01 draft carried a
 * `messages` snapshot; step-13 hooks are stateless predicates and read
 * messages through `HookPayload.extra` when needed.
 */
export interface LegacyHookHandler {
  (ctx: HookContext & { messages: ChatMessage[] }): Promise<HookOutcome> | HookOutcome;
}
