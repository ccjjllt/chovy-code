/**
 * Hook engine contracts (DRAFT).
 *
 * Canonical shape is frozen in step-13 (8 event types + race semantics).
 * Hooks are user-supplied async predicates that can allow / block / mutate
 * agent actions at well-defined lifecycle points.
 */
import type { ChatMessage } from "./messages.js";

/** The 8 hook event types. Frozen here; runtime wiring in step-13. */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubAgentStop"
  | "PreCompact"
  | "Notification"
  | "SessionStart";

/**
 * Possible outcomes of a single hook handler. `modify` is the only outcome
 * that mutates the message list — the engine merges the returned slice in
 * place of the snapshot it passed in.
 */
export type HookOutcome =
  | { type: "allow" }
  | { type: "block"; reason: string }
  | { type: "modify"; messages: ChatMessage[] }
  | { type: "skip" };

/** Context passed to each hook handler. Engine populates it per event. */
export interface HookContext {
  event: HookEvent;
  /** Tool name; present for `PreToolUse` / `PostToolUse`. */
  toolName?: string;
  /** Tool args; present for `PreToolUse`. */
  toolArgs?: unknown;
  /** Current message list snapshot (read-only from the handler's view). */
  messages: ChatMessage[];
  /** Abort signal — handlers MUST honor it. */
  signal: AbortSignal;
}

/** A hook handler. May be sync or async. */
export type HookHandler = (
  ctx: HookContext,
) => Promise<HookOutcome> | HookOutcome;
