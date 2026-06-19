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
import type { AgentLifecycle, AgentRole } from "../types/agent.js";
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
  | {
      /**
       * step-28: emitted exactly once per SCW rebuild (hard threshold path).
       * Single source is `src/context/rebuilder.ts` (mirrors the §22
       * `context.threshold` / monitor single-source invariant — neither the
       * monitor nor the QueryEngine emits this event). `tokens` is the
       * pre-rebuild token estimate (the input that triggered rebuild);
       * `dropped` is the count of messages elided from the live window
       * (jsonl file is the canonical archive); `kept` is the recent-K
       * count preserved verbatim. `durMs` is end-to-end rebuild time
       * including selector I/O.
       */
      type: "context.rebuild";
      tokens: number;
      kept: number;
      dropped: number;
      checkpointBytes: number;
      memoryEntries: number;
      durMs: number;
      ts: number;
    }
  | {
      /**
       * step-23: emitted exactly once when `runGoal()` enters the loop.
       * Single source is `src/goals/iterations.ts`. `convergence` is the
       * resolved mode tag (`rubric` / `command` / `hybrid`); the rubric
       * text and shell command stay on the persisted state file (they
       * may contain user-private info — telemetry is JSONL on disk too,
       * but we want the wire shape consistent with `agent.start`).
       */
      type: "goal.start";
      goalId: string;
      threadId: string;
      convergence: "rubric" | "command" | "hybrid";
      maxRounds: number;
      budgetUSD: number;
      ts: number;
    }
  | {
      /**
       * step-23: emitted once when `runGoal()` exits the loop. `status` is
       * the terminal `GoalStatus`; `rounds` is final round count; `costUSD`
       * is `goal.totalCostUSD` (engine + rubric judge folded in, mirrors
       * step-21 judge cost folding into dispatch).
       */
      type: "goal.end";
      goalId: string;
      threadId: string;
      status: "achieved" | "failed" | "cancelled" | "paused";
      rounds: number;
      costUSD: number;
      ts: number;
    }
  | {
      /**
       * step-23: emitted at the START of each goal-loop iteration (matches
       * the `tools.described` / `prompt.shape` per-round pattern). The
       * loop emits this BEFORE the engine round so cancelled / failed
       * runs still leave a breadcrumb. Single source is
       * `src/goals/iterations.ts`; `converged` is filled in for the
       * round that actually ran the convergence check (false otherwise).
       */
      type: "goal.iteration";
      goalId?: string;
      round: number;
      converged: boolean;
      ts: number;
    }
  | { type: "memory.injection"; bytes: number; entries: number; ts: number }
  | {
      /**
       * step-24: emitted once per `store.rebuild()` or full `syncProject()`.
       * Single source is `src/memory/store.ts` (and `syncFromFiles.ts` for
       * incremental sync). `degraded:true` means `bun:sqlite` was unavailable
       * and the InMemoryStore is being used (FTS5 disabled, LIKE fallback).
       * `count` is the total record count after the operation; `durMs` is
       * wall-clock for the rebuild/sync.
       */
      type: "memory.index";
      projectId: string;
      op: "rebuild" | "sync" | "init";
      count: number;
      durMs: number;
      degraded: boolean;
      ts: number;
    }
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
    }
  | {
      /**
       * step-18: emitted exactly once when `pool.spawn` registers a new
       * sub-agent handle. Single source is `src/agent/pool.ts`.
       * `parentId` is the parent agent id (or main session id at the
       * top level); `background: true` means the parent did not await.
       */
      type: "subagent.spawn";
      id: string;
      parentId: string;
      role: AgentRole;
      background: boolean;
      ts: number;
    }
  | {
      /**
       * step-18: emitted exactly once when a sub-agent leaves `running`
       * (`done` / `failed` / `cancelled`). Single source is the pool.
       * `durMs` is wall-clock from `spawnedAt` to `finishedAt`.
       */
      type: "subagent.end";
      id: string;
      parentId: string;
      status: AgentLifecycle;
      costUSD: number;
      durMs: number;
      ts: number;
    }
  | {
      /**
       * step-26: emitted exactly once per checkpoint write. Single source
       * is `src/memory/checkpointWriter.ts` — neither the agent itself nor
       * the goal loop should emit it. `mode` distinguishes the agent-driven
       * write (`agent`) from the rule-based fallback (`fallback`) used when
       * the spawn fails / times out / produces an empty payload.
       * `reason` mirrors the trigger source (`goal-round` / `manual` /
       * `session-end` / `token-soft` / `big-event`).
       */
      type: "checkpoint.written";
      path: string;
      bytes: number;
      reason: string;
      mode: "agent" | "fallback";
      durMs: number;
      ts: number;
    }
  | {
      /**
       * step-29 (CSG): emitted exactly once per `runSkillRound` call (which
       * includes manual-only no-ops and skipped/disabled rounds — those just
       * report `selected: []` and `mode: 'manual-only'`). Single source is
       * `src/engine/skillHook.ts`; SkillTool / slash commands MUST NOT emit
       * this directly (mirrors the §22 `context.threshold` invariant).
       *
       * `mode` distinguishes:
       *   - `auto` — planner ran (CHOVY_SKILLS_AUTO=1 or feature flag on).
       *   - `manual-only` — auto disabled; only manual activations carried.
       *   - `disabled` — registry empty / engine call short-circuited.
       *
       * `fingerprintHit:true` means the planner reused the lock without
       * re-scoring (intent unchanged from last round). `droppedByBudget`
       * counts skills culled to keep `Σ budgetTokens ≤ ContextBudget.skills`;
       * `droppedByConflict` counts those lost to same-conflict-group
       * resolution.
       */
      type: "skill.plan";
      mode: "auto" | "manual-only" | "disabled";
      selected: string[];
      droppedByBudget: number;
      droppedByConflict: number;
      missingRequired: number;
      totalTokens: number;
      budgetTokens: number;
      fingerprintHit: boolean;
      durMs: number;
      ts: number;
    }
  | { type: "tui.theme.change"; name: string; ts: number }
  | { type: "tui.locale.change"; locale: string; preference: string; ts: number }
  | { type: "tui.palette.exec"; id: string; source: string; locale: string; ts: number };

/** Type of an event with `ts` filled in by the sink (so callers can omit it). */
export type TelemetryEventInput = TelemetryEvent extends infer T
  ? T extends { ts: number }
    ? Omit<T, "ts">
    : never
  : never;
