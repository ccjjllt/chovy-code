/**
 * ContextBudget computation (step-28 §ContextBudget).
 *
 * Allocates the active provider's context window across the eight buckets
 * the rebuilder needs (`systemBase / memory / checkpoint / notes /
 * taskProgress / skills / tools / history`). The first seven are *fixed*
 * slabs sourced from the spec table (line 41–53); `history` absorbs the
 * remainder so a 200k window devotes ~150k to the conversation tail.
 *
 * Single-source rules (AGENTS.md §16/§17/§22 延续 → §23 step-28):
 *   - PCM single source: provider window comes from `CAPS[provider]
 *     .contextWindow` via `thresholds()`. We never re-derive the window
 *     here — `thresholds()` is the only place that consults `CAPS`.
 *   - Reserve discipline: `reserveTokens` (cfg + env override) is taken
 *     out before the buckets are allocated, mirroring the soft/hard
 *     thresholds (`thresholds.effectiveWindow`).
 *   - Output is a frozen `ContextBudget`; the rebuilder reads buckets
 *     and never mutates the object.
 *
 * Scaling rule: when the effective window is smaller than the sum of the
 * default fixed slabs, we proportionally shrink them (NOT the reserve)
 * to leave at least 10 % of `effectiveWindow` for `history`. This keeps
 * the rebuilder safe on small models (e.g. 8k ctx) without callers
 * needing to special-case anything.
 */

import type { ContextBudget } from "../types/context.js";
import type { ChovyConfig } from "../config/config.js";
import type { ProviderId } from "../types/provider.js";
import { thresholds } from "./thresholds.js";

/**
 * Default fixed slabs (tokens). Mirror the spec table:
 *
 *   systemBase=1500, memory=4000, checkpoint=3000, notes=1000,
 *   taskProgress=2000, skills=8000, tools=6000.
 *
 * Plus 4000 for output reserve (already accounted for via
 * `thresholds.reserve`, NOT re-subtracted here).
 */
export const DEFAULT_SLABS = {
  systemBase: 1500,
  memory: 4000,
  checkpoint: 3000,
  notes: 1000,
  taskProgress: 2000,
  skills: 8000,
  tools: 6000,
} as const;

/** Lower bound on `history` as a fraction of `effectiveWindow`. */
const MIN_HISTORY_RATIO = 0.1;

/**
 * Compute the per-bucket budget for a (provider, model) pair. `cfg` brings
 * the soft/hard ratios + reserve setting; the resulting `ContextBudget`
 * always satisfies `sum(systemBase..tools) + history ≤ effectiveWindow`
 * (which itself is `ctxWindow - reserve`, so the spec invariant
 * "ContextBudget 总和 ≤ ctx_window - reserve" holds by construction).
 */
export function computeBudget(
  model: string,
  providerId: ProviderId,
  cfg: ChovyConfig,
  env: NodeJS.ProcessEnv = process.env,
): ContextBudget {
  const t = thresholds(model, providerId, cfg, env);
  const effective = t.effectiveWindow;

  const fixedSum =
    DEFAULT_SLABS.systemBase +
    DEFAULT_SLABS.memory +
    DEFAULT_SLABS.checkpoint +
    DEFAULT_SLABS.notes +
    DEFAULT_SLABS.taskProgress +
    DEFAULT_SLABS.skills +
    DEFAULT_SLABS.tools;

  const minHistory = Math.floor(effective * MIN_HISTORY_RATIO);

  // Default branch: window comfortably accommodates the slabs.
  if (effective - fixedSum >= minHistory) {
    const history = effective - fixedSum;
    const budget: ContextBudget = {
      systemBase: DEFAULT_SLABS.systemBase,
      memory: DEFAULT_SLABS.memory,
      checkpoint: DEFAULT_SLABS.checkpoint,
      notes: DEFAULT_SLABS.notes,
      taskProgress: DEFAULT_SLABS.taskProgress,
      skills: DEFAULT_SLABS.skills,
      tools: DEFAULT_SLABS.tools,
      history,
      tail: history, // back-compat alias for step-27 placeholder consumers.
    };
    return Object.freeze(budget);
  }

  // Squeeze branch: model is small (or env cranks reserve up). Scale every
  // fixed slab by `room / fixedSum`; leftover goes to history (≥ minHistory
  // by construction since we sized the slabs to leave that headroom).
  const room = Math.max(0, effective - minHistory);
  const scale = fixedSum > 0 ? room / fixedSum : 0;
  const scaled = {
    systemBase: Math.floor(DEFAULT_SLABS.systemBase * scale),
    memory: Math.floor(DEFAULT_SLABS.memory * scale),
    checkpoint: Math.floor(DEFAULT_SLABS.checkpoint * scale),
    notes: Math.floor(DEFAULT_SLABS.notes * scale),
    taskProgress: Math.floor(DEFAULT_SLABS.taskProgress * scale),
    skills: Math.floor(DEFAULT_SLABS.skills * scale),
    tools: Math.floor(DEFAULT_SLABS.tools * scale),
  };
  const usedFixed =
    scaled.systemBase +
    scaled.memory +
    scaled.checkpoint +
    scaled.notes +
    scaled.taskProgress +
    scaled.skills +
    scaled.tools;
  const history = Math.max(minHistory, effective - usedFixed);

  const budget: ContextBudget = {
    ...scaled,
    history,
    tail: history,
  };
  return Object.freeze(budget);
}

/** Sum of all eight buckets — convenience for smoke checks. */
export function budgetTotal(b: ContextBudget): number {
  return (
    b.systemBase +
    b.memory +
    b.checkpoint +
    b.notes +
    b.taskProgress +
    b.skills +
    b.tools +
    b.history
  );
}
