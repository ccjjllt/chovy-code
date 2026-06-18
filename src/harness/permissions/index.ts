/**
 * Permission engine — public surface (step-12).
 *
 * Consumers:
 *   - `src/agent/agent.ts` constructs a `PermissionEngineState` per run and
 *     calls `hasPermission(tool, args, ctx, state)` before every `tool.run`.
 *   - Tests import the pure helpers (`matchRule`, `checkPathSafety`,
 *     `createDenialState`, …) directly.
 *   - step-13 (hooks) will plug into the L5 call site inside `engine.ts`.
 *   - step-14 (sandbox) layers *below* this engine — a sandboxed command can
 *     still be denied by rules / safety / mode.
 *
 * The `PermissionEngine` interface frozen in `src/types/tool.ts` (the
 * `preflight?` handle on `ToolContext.permissions`) is satisfied by binding
 * `hasPermission` against the live state in the agent loop; this barrel
 * exports the pieces needed to do that wiring.
 */

export {
  createPermissionEngineState,
  hasPermission,
  DENIAL_LIMITS,
  shouldFallbackToPrompting,
  type CreateEngineOptions,
  type PermissionDecision,
  type PermissionEngineState,
} from "./engine.js";

export {
  PERMISSION_MODES,
  isValidPermissionMode,
  permissionModeFromString,
  modeAllowsMutate,
  modeIsReadOnly,
  modePromptsByDefault,
} from "./modes.js";
// Re-export the canonical type (single source: config) for harness consumers.
export type { PermissionMode } from "../../config/index.js";

export {
  parseRuleString,
  ruleToString,
  matchRule,
  matchWildcardPattern,
  loadRulesFromText,
  loadRulesFromPaths,
  defaultRulesPaths,
  type ParsedRule,
  type RuleBehavior,
  type RuleFile,
} from "./rules.js";

export {
  checkPathSafety,
  checkCommandSafety,
  probeArgs,
  type SafetyResult,
  type ToolArgsProbe,
} from "./safety.js";

export {
  createDenialState,
  recordDenial,
  recordSuccess,
  type DenialState,
} from "./denialTracking.js";
