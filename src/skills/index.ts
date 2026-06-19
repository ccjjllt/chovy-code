/**
 * Skills barrel (step-29 — CSG).
 *
 * Public surface for the rest of chovy-code:
 *   - registry  : `registerSkill / getSkill / listSkills / ensureBundledSkillsInitialized`
 *   - planner   : `plan / computeFingerprint`
 *   - graph     : `computeClosure / resolveConflicts / enforceBudget / resolveManualClosure`
 *   - intent    : `extractIntent`
 *   - lock      : `persistSkillsLock / loadSkillsLock`
 *
 * Consumers (engine/skillHook, tools/meta/skill, cli/slashCommands/skill,
 * scripts/smoke-step29) import from this barrel — never reach into
 * sub-modules directly. The bundled skill modules are eagerly registered via
 * `ensureBundledSkillsInitialized()` (called from the engine and CLI before
 * the first plan).
 */

export {
  registerSkill,
  getSkill,
  listSkills,
  skillCount,
  resetSkillRegistry,
  ensureBundledSkillsInitialized,
  markBundledInitialized,
} from "./registry.js";
export {
  computeClosure,
  resolveConflicts,
  enforceBudget,
  resolveManualClosure,
  type ClosureResult,
  type ManualResolveResult,
} from "./graph.js";
export {
  extractIntent,
  type IntentInput,
  type IntentResult,
} from "./intentExtractor.js";
export {
  plan,
  computeFingerprint,
  type PlanInput,
  type PlanOutput,
} from "./planner.js";
export {
  persistSkillsLock,
  loadSkillsLock,
  type SkillsLock,
} from "./lock.js";

// Re-export Skill / SkillNode for callers that want one import path.
export type { Skill, SkillNode, SkillTriggers } from "../types/skill.js";

/** Build the SystemFragment block payload for `skillFragmentsSection`. */
export function renderSkillFragments(
  active: Record<string, string> | undefined,
): { fragments: Array<{ name: string; body: string }> } | undefined {
  if (!active) return undefined;
  const entries = Object.entries(active).filter(
    ([, body]) => typeof body === "string" && body.length > 0,
  );
  if (entries.length === 0) return undefined;
  // Stable order (insertion order from object). The engine handles this
  // by emptying + reinserting each round; tests verify deterministic order.
  return {
    fragments: entries.map(([name, body]) => ({ name, body })),
  };
}
