/**
 * Sandbox module — public surface (step-14).
 *
 * Layers below the permission engine: the permission engine decides
 * *ask/allow/deny*; the sandbox decides *physically can the write/spawn
 * happen*. The two compose:
 *
 *   - `assertWritable` / `assertReadable` — called from inside fs tools'
 *     `run()` so even a bypassed/mock preflight can't escape the
 *     blacklist. Backstops the L1g safety check in
 *     `harness/permissions/safety.ts` (which inspects only the literal
 *     path) by resolving symlinks.
 *   - `shouldUseSandbox` + `buildSandboxSpawnArgs` — called by the bash
 *     tool to decide whether a command runs under a restricted child and
 *     to produce that child's `cmd`/`args`/`env`.
 *
 * Consumers:
 *   - `src/tools/fs/write.ts` / `edit.ts` — `assertWritable` before
 *     `safeFs.write`.
 *   - `src/tools/exec/bash.ts` — replaces the step-09 `sandboxStub` with
 *     the real `shouldUseSandbox` + `buildSandboxSpawnArgs`.
 *   - Tests + the smoke script reach the pure helpers directly.
 *
 * Edge rule (AGENTS.md §18): this module is a leaf. It reaches
 * `tools/exec/ast.js` + `tools/exec/classification.js` (zero-dependency
 * pure functions) and `config/index.js` (type-only). It does NOT import
 * the tool registry, so there's no cycle.
 */

export {
  expandPath,
  normalizeCase,
  resolveSymlinkChain,
  isWithinCwd,
  representationsInsideCwd,
} from "./allowlist.js";

export {
  DANGEROUS_FILE_NAMES,
  DANGEROUS_DIR_SEGMENTS,
  assertWritable,
  assertReadable,
  isDangerousPath,
  type AssertResult,
  type AssertWritableOptions,
  type AssertReadableOptions,
} from "./filesystem.js";

export {
  shouldUseSandbox,
  buildSandboxSpawnArgs,
  filterEnv,
  sandboxScratchDir,
  ENV_WHITELIST,
  RESOURCE_LIMITS,
  type SandboxDecisionOptions,
  type SpawnSandboxOpts,
  type SpawnSandboxPlan,
  type BashParseResult,
} from "./shellSandbox.js";
