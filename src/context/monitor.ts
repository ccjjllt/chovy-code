/**
 * ContextMonitor (step-27 §Monitor API).
 *
 * Wraps the tokenizer + thresholds into a stateful per-run monitor. The
 * `QueryEngine` calls `inspect(messages, systemBytes)` once per round
 * BEFORE the provider call (right after the system prompt is built so we
 * can measure both inputs). Returns the new `MonitorState`; on level
 * transitions (`fresh → soft`, `soft → hard`) the monitor side-effects:
 *
 *   - Emits `context.threshold` telemetry (single source per AGENTS.md §17).
 *   - Fire-and-forget `coordinator.maybeCheckpoint('token-soft', ...)`
 *     so the user has a recent on-disk snapshot before step-28's rebuild.
 *   - Notifies any `onLevelChange` subscribers (REPL UI, future SCW logic).
 *
 * The monitor never throws; both the tokenizer and the checkpoint trigger
 * are best-effort. Failures degrade to "no checkpoint this round" + warn.
 *
 * Cancellation discipline (AGENTS.md §9 + §16):
 *   - `parentSignal` is observed only through `addEventListener`; we never
 *     forward it as the checkpoint coordinator's signal directly. The
 *     coordinator has its own local AC for the spawn.
 *   - `inspect()` is synchronous and stateless w.r.t. abortion — even
 *     after `parentSignal` aborts, callers can still call `inspect()` to
 *     retrieve a final snapshot for telemetry / UI.
 *
 * Single-source telemetry: this file is the only emitter of
 * `context.threshold`. QueryEngine, REPL, coordinator MUST NOT emit it
 * directly.
 */

import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import type { ChatMessage } from "../types/messages.js";
import type { ProviderId } from "../types/provider.js";
import type { ChovyConfig } from "../config/config.js";
import type { CheckpointCoordinator, CheckpointReason } from "../memory/checkpointWriter.js";
import type { GoalHistoryEntry } from "../types/goal.js";
import type { AgentRole } from "../types/agent.js";
import { CAPS, type ProviderFamily } from "../providers/capabilities.js";
import {
  pickEstimator,
  type TokenEstimator,
} from "./tokenizer.js";
import {
  thresholds,
  type ContextThresholds,
} from "./thresholds.js";

// ── Public types (frozen at step-27 per architecture.md §3.3) ──────────────

export type ContextLevel = "fresh" | "soft" | "hard";

export interface MonitorState {
  /** Estimated input tokens for the next provider call (system + messages). */
  total: number;
  /** The same message list passed to `inspect`; passed through so callers
   *  can keep the snapshot alongside the level. Step-28's rebuilder uses
   *  this to re-anchor the conversation. */
  effective: ChatMessage[];
  thresholds: ContextThresholds;
  level: ContextLevel;
  /** True iff this `inspect()` flipped the level (fresh→soft, soft→hard). */
  transitioned: boolean;
  /** True iff a checkpoint trigger fired this call. The coordinator's own
   *  30 s debounce may collapse it; this is just whether we *attempted*. */
  checkpointTriggered: boolean;
}

export type Unsubscribe = () => void;

export interface ContextMonitorDeps {
  /** Token estimator. Defaults to `pickEstimator(providerFamily)`. */
  tokenizer?: TokenEstimator;
  /** Provider id — drives PCM ctx window lookup + estimator family. */
  providerId: ProviderId;
  /** Active model id (advisory; today only used for telemetry context). */
  model: string;
  /** Resolved chovy config (for soft/hard ratios). */
  cfg: ChovyConfig;
  /** Process env (defaults to `process.env`). Tests override for ratio knobs. */
  env?: NodeJS.ProcessEnv;
  /** Checkpoint coordinator — fire-and-forget on transitions. Optional so
   *  isolated tests don't need to wire it. */
  checkpoints?: CheckpointCoordinator;
  /** cwd for the checkpoint trigger (project paths derive from this). */
  cwd: string;
  /** Thread / session id for telemetry + checkpoint correlation. */
  threadId: string;
  /** Caller signal (engine's local AC). The monitor only observes it. */
  parentSignal?: AbortSignal;
  /** Pull most recent K messages at trigger time (engine pushes its live
   *  array; monitor never holds a reference to mutate). */
  getRecentMessages?: () => ChatMessage[];
  /** Pull current goal objective text for the checkpoint prompt (optional). */
  getObjective?: () => string | undefined;
  /** Pull tail of goal.history (last 5 entries by convention). */
  getHistoryTail?: () => GoalHistoryEntry[];
  /** Caller's parent role (passed through to the checkpoint coordinator). */
  parentRole?: AgentRole;
}

export interface ContextMonitor {
  /** Read-only thresholds snapshot (re-computed at construction). */
  readonly thresholds: ContextThresholds;
  /** Active level (most recent `inspect()` result). */
  readonly level: ContextLevel;
  /** Compute a fresh `MonitorState` and side-effect on transitions. */
  inspect(messages: ChatMessage[], systemBytes: number): MonitorState;
  /** Subscribe to level changes; idempotent unsubscribe. */
  onLevelChange(cb: (state: MonitorState) => void): Unsubscribe;
  /** Test hook — clear listeners + level. Production callers don't need it. */
  _resetForTesting(): void;
}

// ── Implementation ─────────────────────────────────────────────────────────

class ContextMonitorImpl implements ContextMonitor {
  readonly thresholds: ContextThresholds;
  private _level: ContextLevel = "fresh";
  private listeners = new Set<(s: MonitorState) => void>();
  private readonly tokenizer: TokenEstimator;
  private readonly deps: ContextMonitorDeps;

  constructor(deps: ContextMonitorDeps) {
    this.deps = deps;
    const env = deps.env ?? process.env;
    this.thresholds = thresholds(deps.model, deps.providerId, deps.cfg, env);
    const family: ProviderFamily | undefined = CAPS[deps.providerId]?.family;
    this.tokenizer = deps.tokenizer ?? pickEstimator(family);
  }

  get level(): ContextLevel {
    return this._level;
  }

  inspect(messages: ChatMessage[], systemBytes: number): MonitorState {
    let total = 0;
    try {
      total =
        this.tokenizer.countMessages(messages) +
        this.tokenizer.countString(makeFiller(systemBytes));
    } catch (err) {
      // Estimator should never throw — if it does, skip transition logic
      // for this round (state.level stays put). Smoke §7 covers this.
      logger.warn("context.monitor: tokenizer threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      total = 0;
    }

    const next = pickLevel(total, this.thresholds);
    const prev = this._level;
    const transitioned = isUpwardTransition(prev, next);
    let checkpointTriggered = false;

    if (transitioned) {
      this._level = next;
      // Single-source telemetry per AGENTS.md §17/§22 (this file is the
      // only emitter of `context.threshold`). `level` of the union is
      // `'soft' | 'hard'` — `fresh` doesn't get a shape, by design.
      if (next !== "fresh") {
        emitTelemetry({
          type: "context.threshold",
          level: next,
          tokens: total,
        });
      }
      // Fire-and-forget checkpoint trigger. We use 'token-soft' for both
      // soft AND hard transitions because step-26 hasn't shipped a
      // 'token-hard' reason and 30 s per-reason debounce naturally
      // throttles fast soft→hard flips.
      checkpointTriggered = this.fireCheckpoint(next, total);
    }

    const state: MonitorState = {
      total,
      effective: messages,
      thresholds: this.thresholds,
      level: this._level,
      transitioned,
      checkpointTriggered,
    };

    if (transitioned && this.listeners.size > 0) {
      // Each listener is best-effort — UI subscribers throw means we
      // surface the bug at debug level, not crash the engine round.
      for (const cb of this.listeners) {
        try {
          cb(state);
        } catch (err) {
          logger.debug("context.monitor: listener threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return state;
  }

  onLevelChange(cb: (state: MonitorState) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  _resetForTesting(): void {
    this.listeners.clear();
    this._level = "fresh";
  }

  private fireCheckpoint(level: ContextLevel, tokens: number): boolean {
    if (!this.deps.checkpoints) return false;
    if (level === "fresh") return false;
    const coord = this.deps.checkpoints;
    const reason: CheckpointReason = "token-soft";
    // Pull live snapshots through callbacks (the monitor never caches a
    // ref to the engine's mutable arrays — would race with the next round).
    const recent = this.deps.getRecentMessages?.() ?? [];
    const history = this.deps.getHistoryTail?.() ?? [];
    const objective = this.deps.getObjective?.();

    // Best-effort. Coordinator owns its own debounce + telemetry.
    void coord
      .maybeCheckpoint(reason, {
        cwd: this.deps.cwd,
        objective,
        recentMessages: recent,
        historyTail: history,
        provider: this.deps.providerId,
        model: this.deps.model,
        threadId: this.deps.threadId,
        parentSignal: this.deps.parentSignal,
        parentRole: this.deps.parentRole ?? "main",
      })
      .catch((err: unknown) => {
        logger.warn("context.monitor: checkpoint trigger threw", {
          level,
          tokens,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pickLevel(tokens: number, t: ContextThresholds): ContextLevel {
  if (tokens >= t.hard) return "hard";
  if (tokens >= t.soft) return "soft";
  return "fresh";
}

/**
 * Only count *upward* transitions (fresh→soft, soft→hard, fresh→hard).
 * Step-27 doesn't emit on downward transitions because rebuild (step-28)
 * owns the post-checkpoint reset; until then the monitor stays in its
 * highest observed level so we don't re-fire the soft trigger when the
 * caller temporarily prunes a few messages.
 */
function isUpwardTransition(prev: ContextLevel, next: ContextLevel): boolean {
  const order: Record<ContextLevel, number> = { fresh: 0, soft: 1, hard: 2 };
  return order[next] > order[prev];
}

/**
 * The tokenizer takes a string for `countString`. We have a byte count for
 * the system prompt and don't want to pass it through unchanged (a real
 * string would be expensive to construct). Fabricate a same-length ASCII
 * placeholder so the estimator's char/4 ratio resolves to the same number.
 *
 * NOTE: this is correct because `defaultEstimator.countString(s)` only
 * touches `s.length`. If a future estimator inspects content, callers
 * MUST switch to passing the real system prompt text.
 */
function makeFiller(bytes: number): string {
  if (bytes <= 0) return "";
  // Pre-allocated cache of common sizes to avoid repeat allocations.
  return "x".repeat(bytes);
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Construct a per-run monitor. The engine calls this once per `run()`,
 * passing in the resolved provider/model/cfg + the engine's local
 * AbortController signal. Sub-agents construct their own (AGENTS.md §9).
 */
export function createContextMonitor(deps: ContextMonitorDeps): ContextMonitor {
  return new ContextMonitorImpl(deps);
}

/** Internal helper exposed for the smoke test (deterministic transition
 *  bookkeeping); production callers never need it. */
export const _internalsForTesting = {
  pickLevel,
  isUpwardTransition,
  makeFiller,
};
