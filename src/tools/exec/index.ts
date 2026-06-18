/**
 * `src/tools/exec` — public barrel for the bash tool family (step-09).
 *
 * Mirrors the `src/tools/fs/index.ts` layout: the bash tool plus the
 * helpers test fixtures / step-23 / step-14 will reach for. Keep this
 * surface deliberate so plugins (step-25 horizon) cannot reach into
 * internal helpers like `EndTruncatingAccumulator` until we promote
 * them.
 */

export { bashTool } from "./bash.js";
export {
  peekLastHint,
  clearHintSlot,
  listBackgroundTasks,
  type ChovyHint,
  type SandboxLike,
} from "./bash.js";

// Parser / classification are exposed so the smoke script (and later the
// permission engine / Ink panels) can introspect a command without
// re-running it through the tool.
export {
  parseBashCommand,
  extractBaseCommand,
  type BashParse,
  type BashParseResult,
  type BashParseFailure,
  type SimpleCommand,
  type Redirect,
  type ChainOp,
} from "./ast.js";

export {
  classifyBaseCommand,
  classifyCommands,
  isAllReadOnly,
  type CommandClass,
} from "./classification.js";

export {
  EndTruncatingAccumulator,
  type AccumulatorOptions,
} from "./outputAccumulator.js";
