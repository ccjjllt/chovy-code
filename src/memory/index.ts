/**
 * Public barrel for `src/memory/` (step-24 §产物).
 *
 * Higher-level modules (CLI, step-25/30 injection, step-26 checkpoint
 * writer) import from this barrel rather than cherry-picking individual
 * files. Re-exports follow the AGENTS.md §16 single-source pattern: types
 * come from `src/types/memory.ts`, runtime is in `store.ts` / parser etc.
 */

export type {
  MemoryLayer,
  MemoryQuery,
  MemoryRecord,
  MemoryType,
} from "../types/memory.js";

export { MEMORY_LAYERS, MEMORY_TYPES } from "../types/memory.js";

export {
  createMemoryStore,
  memoryProjectDir,
  _forceInMemoryForTesting,
  _resetSqliteProbeForTesting,
  type MemoryStore,
  type MemoryStoreListFilter,
  type CreateMemoryStoreOptions,
} from "./store.js";

export {
  parseMemoryDocument,
  inferLayerFromPath,
  clampImportance,
  DEFAULT_IMPORTANCE,
  DEFAULT_TYPE,
  FALLBACK_IMPORTANCE,
  type FrontmatterMeta,
  type ParseResult,
  type ParsedMemory,
} from "./parser.js";

export {
  syncProject,
  forceRebuild,
  type SyncResult,
} from "./syncFromFiles.js";

export {
  buildMemoryPromptSegment,
  type BuildMemoryPromptSegmentInput,
  type BuildMemoryPromptSegmentResult,
} from "./injection.js";

export {
  scoreMemoryRecord,
  compareScoredMemory,
  type MemoryScoreQuery,
} from "./ranker.js";

export {
  selectMemoryRecords,
  estimateTokens as estimateMemoryTokens,
  type SelectMemoryInput,
  type SelectMemoryOutput,
} from "./selector.js";

export {
  renderMemoryPromptSegment,
  type RenderMemorySegmentInput,
  type RenderMemorySegmentOutput,
} from "./promptSegment.js";

export {
  readMemoryFile,
  writeMemoryFile,
  appendMemoryEntry,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_LINES,
  type MemoryFileRead,
} from "./files/memoryFile.js";

export {
  readNotesFile,
  writeNotesFile,
  appendNote,
  MAX_NOTES_LINES,
  MAX_NOTES_BYTES,
  type NotesFileRead,
} from "./files/notesFile.js";

export {
  readProgressFile,
  writeProgressFile,
  appendProgress,
  PROGRESS_TAIL_BYTES,
  type ProgressFileRead,
} from "./files/progressFile.js";

export {
  MIGRATIONS_SQL,
  SCHEMA_VERSION,
  splitStatements,
} from "./migrations.js";

// step-26: structured-checkpoint coordinator (`docs/step-26-checkpoint-writer.md`).
// Owns trigger debouncing, sub-agent spawn for the writer role, archive
// rotation, fallback path, hook + telemetry emission. Single source for
// the `checkpoint.written` telemetry event (AGENTS.md §17).
export {
  CheckpointCoordinator,
  getCheckpointCoordinator,
  _resetCheckpointCoordinatorForTesting,
  buildSnapshotPrompt,
  buildFallbackMarkdown,
  extractFinalMarkdown,
  rotateArchive,
  truncateBody,
  DEBOUNCE_WINDOW_MS,
  MAX_ARCHIVE_FILES,
  MAX_CHECKPOINT_BYTES,
  type CheckpointReason,
  type CheckpointInput,
  type CheckpointResult,
  type CheckpointCoordinatorDeps,
} from "./checkpointWriter.js";
