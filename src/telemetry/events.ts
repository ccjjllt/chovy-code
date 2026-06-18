/**
 * Telemetry event types.
 *
 * Step-03 freezes the event union shape. Later steps fill in the placeholder
 * cross-module types once their owning steps land.
 *
 * Single-source rule (AGENTS.md §16): cross-module union types live in their
 * owning module and are re-exported here:
 *   - `AgentRole`   → `src/types/agent.ts`
 *   - `PromptShape` → `src/prompts/fingerprint.ts` (step-15)
 *
 * `AgentRole` was originally inlined as a parallel literal union but the names
 * diverged (`explore` vs `explorer`) — Phase B verification (2026-06-18)
 * unified them on `types/agent.ts`. Step-15 applies the same rule to
 * `PromptShape`: the placeholder shape (`hash` / `layers` / `tokens`) is gone;
 * consumers MUST import the real shape from `prompts/fingerprint.ts` (or via
 * the `prompts` barrel). Only one telemetry event references it today
 * (`prompt.shape`) and step-16's QueryEngine is the first emitter.
 */

export type { AgentRole } from "../types/agent.js";
export type { PromptShape } from "../prompts/fingerprint.js";
import type { AgentRole } from "../types/agent.js";
import type { PromptShape } from "../prompts/fingerprint.js";

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
    }
  | {
      /**
       * step-16: emitted once per provider round when usage is reported.
       * Single source is `engine/costTracker.ts` — `QueryEngine` MUST NOT
       * emit it directly. Lets `chovy log tail` audit spend without a
       * dedicated CLI subcommand. `cacheRead` / `cacheWrite` are the
       * prompt-cache aware splits (Anthropic etc.); other providers
       * report them as 0.
       */
      type: "agent.cost";
      agentId: string;
      provider: string;
      model: string;
      usd: number;
      tokensIn: number;
      tokensOut: number;
      cacheRead: number;
      cacheWrite: number;
      ts: number;
    };

/** Type of an event with `ts` filled in by the sink (so callers can omit it). */
export type TelemetryEventInput = TelemetryEvent extends infer T
  ? T extends { ts: number }
    ? Omit<T, "ts">
    : never
  : never;
