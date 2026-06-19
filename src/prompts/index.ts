/**
 * `src/prompts/` barrel — public surface for the system prompt builder.
 *
 * Consumers (today): `src/engine/queryEngine.ts` (step-16),
 * `src/agent/runAgent.ts` (step-16), `src/cli/...` (later).
 *
 * Tests can reach internals via this barrel — `fnv1a` is exposed as
 * `_fnv1aForTesting` from `fingerprint.ts` rather than re-exported here so
 * production callers don't import it accidentally.
 */

export {
  buildEffectiveSystemPrompt,
  PROMPT_DYNAMIC_BOUNDARY,
  type AgentPromptInput,
  type BuildOptions,
  type EffectivePrompt,
  type PromptSegment,
  type SystemContext,
  type SystemPromptLayer,
} from "./builders.js";

export {
  CHOVY_PROMPT_DYNAMIC_BOUNDARY,
  splitAtBoundary,
} from "./boundary.js";

export {
  defaultStaticPrompt,
  boundaryGlue,
} from "./default.js";

export {
  cwdSection,
  modelSection,
  memorySection,
  notesSection,
  skillsSection,
  skillFragmentsSection,
  contextBudgetSection,
  pressureSection,
  joinSections,
  type CwdSnippet,
  type ContextBudgetSnippet,
  type PressureSnippet,
  type SkillFragmentsSnippet,
} from "./snippets.js";

export {
  computeShape,
  diffShape,
  type PromptShape,
  type ShapeDiff,
} from "./fingerprint.js";
