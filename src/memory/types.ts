/**
 * Re-export of the canonical memory types (single source =
 * `src/types/memory.ts`, B4 frozen at step-24).
 *
 * Memory consumers (CLI, store, files, sync, future step-25 injection) import
 * from this barrel so the `memory` module stays self-contained without
 * redeclaring wire formats — same pattern as `harness/permissions/modes.ts`
 * re-exporting `PermissionMode` (AGENTS.md §16).
 */

export {
  MEMORY_LAYERS,
  MEMORY_TYPES,
} from "../types/memory.js";

export type {
  MemoryLayer,
  MemoryType,
  MemoryRecord,
  MemoryQuery,
} from "../types/memory.js";
