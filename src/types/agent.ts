/**
 * Agent / sub-agent type contracts (DRAFT).
 *
 * The canonical shapes are frozen in:
 *   - step-18 (sub-agent runtime — `SubAgentHandle`, `AgentLifecycle`)
 *   - step-19 (built-in agents — `BuiltInAgentDefinition`)
 *
 * This file intentionally exports only the *minimum* surface needed by the
 * later phases so that downstream modules can import these types early
 * without forcing premature design decisions.
 */
import type { ChatMessage } from "./messages.js";
import type { ProviderId } from "./provider.js";

/** Roles a (sub-)agent can play. The four built-in roles ship in step-19. */
export type AgentRole =
  | "main"
  | "explorer"
  | "planner"
  | "verifier"
  | "critic"
  | "checkpoint-writer"
  | "custom";

/**
 * Lifecycle status for any (sub-)agent. Mirrors the state machine in
 * `architecture.md §4.1`.
 */
export type AgentLifecycle =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "paused";

/**
 * A handle to a running sub-agent (SwarmR; step-18, step-20).
 * The shape is observable by Ink UI panels (step-22) — UI code MUST treat
 * these fields as read-only snapshots.
 */
export interface SubAgentHandle {
  id: string;
  parentId: string;
  role: AgentRole;
  prompt: string;
  status: AgentLifecycle;
  /** Free-form phase label, e.g. "explore-files". */
  phase: string;
  spawnedAt: number;
  finishedAt?: number;
  costUSD: number;
  tokensIn: number;
  tokensOut: number;
  /** Optional provider override; falls back to parent. */
  provider?: ProviderId;
  /** Optional model override; falls back to parent. */
  model?: string;
  /** Captured final assistant transcript (set on `status === "done"`). */
  result?: ChatMessage[];
}

/**
 * Definition for a built-in agent role (step-19).
 *
 * TODO step-19: lock down the prompt-merging semantics and the
 * allowedTools / disallowedTools precedence rules.
 */
export interface BuiltInAgentDefinition {
  role: AgentRole;
  description: string;
  /** Tool families or names this role MAY call (whitelist). */
  allowedTools?: string[];
  /** Tool families or names this role MUST NOT call (blacklist). */
  disallowedTools?: string[];
  /** Provider preference; falls back to parent if unset. */
  preferredProvider?: ProviderId;
  /** Model preference; falls back to parent if unset. */
  preferredModel?: string;
  /** When true, this agent does NOT see parent memory (least context). */
  omitMemory?: boolean;
  /** System prompt fragment merged in step-15. */
  systemPrompt: string;
}
