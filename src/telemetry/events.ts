/**
 * Telemetry event types.
 *
 * Step-03 freezes the event union shape. Later steps will fill in the
 * placeholder cross-module types (PromptShape) once their owning steps land.
 *
 * `AgentRole` is re-exported from `src/types/agent.ts` so we keep one source
 * of truth. step-03 originally inlined a parallel literal union but the
 * names diverged (`explore` vs `explorer`) — Phase B verification (2026-06-18)
 * unified them on `types/agent.ts` to avoid silent role-string mismatches
 * between telemetry and the relevance scorer / sub-agent runtime.
 */

export type { AgentRole } from "../types/agent.js";
import type { AgentRole } from "../types/agent.js";

// TODO step-15: replace with PromptShape exported from src/prompts/fingerprint.ts.
export interface PromptShape {
  /** Stable hash over the assembled system prompt layers. */
  hash: string;
  /** Number of layers participating in the build. */
  layers: number;
  /** Total tokens (estimated) of the final prompt. */
  tokens: number;
}

export type TelemetryEvent =
  | { type: "agent.start"; agentId: string; role: AgentRole; ts: number }
  | { type: "agent.end"; agentId: string; status: string; costUSD: number; ts: number }
  | { type: "tool.call"; tool: string; ok: boolean; durMs: number; ts: number }
  | {
      /**
       * step-07: emitted once per `describeTools()` dispatch so we can audit
       * lean/full ratios, dropped tools, and remaining headroom on disk.
       * Privacy-safe — no message content, only counts and the role label.
       */
      type: "tools.described";
      total: number;
      lean: number;
      full: number;
      droppedCount: number;
      budgetTokens: number;
      upgradeBudgetRemaining: number;
      role: AgentRole;
      ts: number;
    }
  | { type: "context.threshold"; level: "soft" | "hard"; tokens: number; ts: number }
  | { type: "goal.iteration"; round: number; converged: boolean; ts: number }
  | { type: "memory.injection"; bytes: number; entries: number; ts: number }
  | { type: "swarm.dispatch"; n: number; parallelism: number; ts: number }
  | { type: "prompt.shape"; shape: PromptShape; ts: number }
  | {
      /**
       * step-13: emitted once per hook execution. Single source is the
       * hook engine (`src/harness/hooks/engine.ts`) — hook runners MUST
       * NOT emit it themselves (mirrors the §17 `tool.call` invariant).
       * `outcome` is the per-hook result: `ok` (exit 0, no block),
       * `blocked` ({ok:false} or decisive deny), `bypassed` (no hook /
       * trust-gated / timeout / non-zero exit), `error` (runner threw),
       * `timeout` (hit the per-hook cap).
       */
      type: "hook.run";
      event: string;
      hookName: string;
      outcome: "ok" | "blocked" | "bypassed" | "error" | "timeout";
      durMs: number;
      ts: number;
    };

/** Type of an event with `ts` filled in by the sink (so callers can omit it). */
export type TelemetryEventInput = TelemetryEvent extends infer T
  ? T extends { ts: number }
    ? Omit<T, "ts">
    : never
  : never;
