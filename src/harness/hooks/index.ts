/**
 * Hook engine — public surface (step-13).
 *
 * Consumers:
 *   - `src/agent/agent.ts` constructs a hook engine per run via
 *     `createHookEngine` and injects it into `ctx.hooks`. It emits
 *     SessionStart / PreToolUse / PostToolUse / PostToolUseFailure around
 *     the tool-execution loop.
 *   - `src/harness/permissions/engine.ts` L5 calls `ctx.hooks.runPermissionRequest`
 *     to race the user prompt; a decisive verdict short-circuits L6.
 *   - Tests import the pure helpers (`compileMatcher`, `parseHookResult`,
 *     `isTrusted`, `captureSnapshotFromText`, …) directly.
 *   - step-22 (AskUserOverlay) will `Promise.race` the user prompt against
 *     `runPermissionRequest`; step-18 (sub-agents) construct their own
 *     engine (independent snapshot + AbortController per AGENTS.md §9).
 *
 * The `HookEngine` interface frozen in `src/types/tool.ts` (the `emit?` +
 * `runPermissionRequest?` handles on `ToolContext.hooks`) is satisfied by
 * the object `createHookEngine` returns.
 */

export {
  createHookEngine,
  describeHook,
  type HookEngineOptions,
  type HookEngineInternal,
} from "./engine.js";

// Snapshot + settings + trust + runners helpers (re-exported so tests and
// the agent loop can reach them from one barrel).
export {
  captureSnapshot,
  captureSnapshotFromText,
  captureSnapshotFromHooks,
  hasHookForEvent,
  type HookSnapshot,
} from "./snapshot.js";

export {
  compileMatcher,
  matchesHook,
  hookContentFor,
  defaultSettingsPaths,
  loadSettingsFromPaths,
  loadSettingsFromText,
  clampTimeout,
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_TIMEOUT_MS,
  TOOL_SCOPED_EVENTS,
  type CompiledMatcher,
  type SettingsFile,
} from "./settings.js";

export {
  isTrusted,
  markTrusted,
  revokeTrust,
  shouldAllowManagedHooksOnly,
  normalizeCwdKey,
  trustFilePath,
} from "./trust.js";

export {
  buildHookInput,
  parseHookResult,
  parsePermissionDecision,
  runCommandHook,
  runFunctionHook,
  type RunnerResult,
  type RunnerOutcome,
} from "./runners.js";

// Canonical hook types (single source: src/types/hook.ts). Re-exported so
// harness consumers import from one place without reaching into types/.
export type {
  HookEvent,
  HookOutcome,
  HookResult,
  HookPermissionDecision,
  HookContext,
  HookPayload,
  HookConfig,
  HookEngine,
} from "../../types/hook.js";
