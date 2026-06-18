/**
 * Barrel for `src/tools/fs/*` (step-08).
 *
 * Importers should pull from `chovy-code/tools/fs` (or its alias) rather
 * than reaching into individual files. The full set of fs tools registered
 * with the registry lives in `src/tools/index.ts`; this barrel just
 * re-exports the tool objects and the shared file-history helpers so
 * tests can poke at internal state.
 */

export { fileReadTool } from "./read.js";
export { fileWriteTool } from "./write.js";
export { fileEditTool } from "./edit.js";
export { globTool } from "./glob.js";
export { grepTool, _resetRipgrepProbeForTesting } from "./grep.js";

export {
  markRead,
  wasRead,
  recordChange,
  getHistory,
  lineDelta,
  _resetFileHistoryForTesting,
} from "./fileHistory.js";
export type { FileHistoryEntry } from "./fileHistory.js";
