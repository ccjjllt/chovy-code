/**
 * `src/goals/` barrel — public surface for the goal-loop layer (step-23).
 *
 * Consumers:
 *   - `src/cli/slashCommands/goal.ts`         — REPL `/goal …` commands
 *   - `src/cli/index.tsx`                     — headless `chovy goal "…"`
 *   - `src/cli/components/GoalPanel.tsx`      — Ink UI panel
 *   - `scripts/smoke-step23.ts`               — verification
 *
 * State / persistence:
 */
export {
  createGoal,
  dropActiveGoal,
  finalizeGoal,
  getActiveGoal,
  inferConvergence,
  listGoals,
  loadGoal,
  parseGoalCommand,
  persistGoal,
  updateGoal,
  _resetGoalsForTesting,
  CHECKPOINT_INTERVAL_ROUNDS,
  DEFAULT_BUDGET_USD,
  DEFAULT_MAX_ROUNDS,
  NO_PROGRESS_LIMIT,
  type CreateGoalInput,
  type ParsedGoalCommand,
} from "./goalState.js";

/** Convergence judge. */
export {
  evaluate as evaluateConvergence,
  type EvaluateOptions,
  type EvaluateResult,
} from "./convergence.js";

/** Iteration loop. */
export {
  runGoal,
  type RunGoalOptions,
  type RunGoalResult,
} from "./iterations.js";

/** Hook helpers. */
export {
  emitGoalIteration,
  type GoalIterationPayload,
} from "./goalHook.js";

/** Checkpoint trigger. */
export { shouldCheckpoint, triggerCheckpoint } from "./checkpoint.js";
