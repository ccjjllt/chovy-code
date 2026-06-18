/**
 * File ↔ DB synchronization (step-24 §文件 ↔ DB 同步).
 *
 * The filesystem is the *primary source*: MEMORY.md / notes.md / progress.md
 * / checkpoints/*.md are what the user (and step-26 checkpoint-writer) edit.
 * The SQLite store is a derived index whose job is to make full-text search
 * across thousands of records fast — never to be the canonical source.
 *
 * Two entry points:
 *
 *   - `syncProject(cwd, store)` — incremental: re-parses only the files
 *     whose mtime exceeds the cached `memory_index_meta.mtime`.
 *
 *   - `forceRebuild(cwd, store)` — wipes every record + meta-row for the
 *     project and re-parses ALL files. Used by `chovy mem rebuild` (and
 *     anywhere `MEMORY_INDEX_CORRUPT` was raised).
 *
 * Both paths are idempotent. Failure to read any individual file is logged
 * and skipped — a corrupt notes.md should not block project-wide indexing.
 */

import { join } from "node:path";

import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { safeFs } from "../fs/safeFs.js";
import {
  checkpointDir,
  goalsDir,
  memoryFile,
  notesFile,
  projectId as projectIdOf,
  taskDir,
  tasksDir,
} from "../fs/paths.js";
import {
  inferLayerFromPath,
  parseMemoryDocument,
  type ParsedMemory,
} from "./parser.js";
import type { MemoryRecord } from "../types/memory.js";
import type { MemoryStore } from "./store.js";

export interface SyncResult {
  /** Number of files visited. */
  filesScanned: number;
  /** Number of files we actually re-parsed (mtime mismatch). */
  filesReindexed: number;
  /** Total records inserted/updated. */
  records: number;
  durMs: number;
}

/**
 * Walk the project's memory sources and reindex anything whose mtime is
 * newer than the cached `indexed_at`.
 */
export async function syncProject(
  cwd: string,
  store: MemoryStore,
): Promise<SyncResult> {
  const t0 = Date.now();
  const pid = projectIdOf(cwd);
  const sources = await collectSourceFiles(cwd);

  let reindexed = 0;
  let totalRecords = 0;

  for (const src of sources) {
    const stat = await safeFs.stat(src.path);
    if (!stat) continue; // file was removed mid-walk
    const cached = await store.getIndexedMtime(pid, src.path);
    if (cached !== null && stat.mtime <= cached) continue; // up-to-date

    try {
      const records = await parseSourceFile(pid, src);
      // Drop any existing rows for this source first so deletions in the
      // file are reflected (otherwise stale records linger forever).
      await store.removeBySource(pid, src.path);
      if (records.length > 0) await store.upsertMany(records);
      await store.setIndexedMtime(pid, src.path, stat.mtime);
      reindexed++;
      totalRecords += records.length;
    } catch (err) {
      // Per §"failure isolation": a single corrupt source should not block
      // project-wide sync.
      logger.warn(`memory.sync: skipped ${src.path}`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durMs = Date.now() - t0;
  if (reindexed > 0) {
    emitTelemetry({
      type: "memory.index",
      projectId: pid,
      op: "sync",
      count: await store.count({ projectId: pid }),
      durMs,
      degraded: store.degraded,
    });
  }
  return {
    filesScanned: sources.length,
    filesReindexed: reindexed,
    records: totalRecords,
    durMs,
  };
}

/**
 * Wipe the project's records + meta-rows and re-parse every source file.
 *
 * Implemented as `store.rebuild(pid, repopulate)` so the underlying engine
 * can wrap the wipe + repopulate in a single transaction.
 */
export async function forceRebuild(
  cwd: string,
  store: MemoryStore,
): Promise<{ count: number; durMs: number; degraded: boolean }> {
  const pid = projectIdOf(cwd);
  const sources = await collectSourceFiles(cwd);

  return store.rebuild(pid, async (insert) => {
    for (const src of sources) {
      try {
        const records = await parseSourceFile(pid, src);
        for (const r of records) insert(r);
      } catch (err) {
        logger.warn(`memory.rebuild: skipped ${src.path}`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // After the tx repopulates rows, also rebuild the mtime cache. We can't
    // do this inside the tx (rebuild() wipes meta) — so we set it here in
    // a follow-up pass.
    for (const src of sources) {
      const stat = await safeFs.stat(src.path);
      if (stat) await store.setIndexedMtime(pid, src.path, stat.mtime);
    }
  });
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

interface SourceFile {
  path: string;
  /** Layer hint forwarded to every record parsed from this file. */
  layer: MemoryRecord["layer"];
}

/**
 * Enumerate every memory source under the project dir:
 *   - `MEMORY.md`              → layer=project
 *   - `notes.md`               → layer=notes
 *   - `checkpoints/*.md`       → layer=checkpoint
 *   - `tasks/<id>/progress.md` → layer=progress
 *   - `goals/<id>.json`        → SKIPPED (state, not memory; step-23 owns it)
 */
async function collectSourceFiles(cwd: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];

  const memory = memoryFile(cwd);
  if (await safeFs.exists(memory)) out.push({ path: memory, layer: "project" });

  const notes = notesFile(cwd);
  if (await safeFs.exists(notes)) out.push({ path: notes, layer: "notes" });

  const checkpoints = checkpointDir(cwd);
  if (await safeFs.exists(checkpoints)) {
    try {
      const entries = await safeFs.list(checkpoints);
      for (const e of entries) {
        if (e.toLowerCase().endsWith(".md")) {
          out.push({ path: e, layer: "checkpoint" });
        }
      }
    } catch (err) {
      logger.debug("memory.sync: failed to list checkpoint dir", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tasks = tasksDir(cwd);
  if (await safeFs.exists(tasks)) {
    try {
      const dirents = await safeFs.list(tasks, { recursive: true });
      for (const e of dirents) {
        if (e.replace(/\\/g, "/").toLowerCase().endsWith("/progress.md")) {
          out.push({ path: e, layer: "progress" });
        }
      }
    } catch (err) {
      logger.debug("memory.sync: failed to list tasks dir", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // goals/ — explicitly skipped: step-23 owns those JSON state files.
  void goalsDir(cwd);
  void taskDir; // silence unused import

  return out;
}

// ---------------------------------------------------------------------------
// Parse a single source file into MemoryRecord[]
// ---------------------------------------------------------------------------

async function parseSourceFile(
  projectId: string,
  src: SourceFile,
): Promise<MemoryRecord[]> {
  const raw = await safeFs.read(src.path);
  const result = parseMemoryDocument(raw);
  const layer = src.layer ?? inferLayerFromPath(src.path);

  return result.records.map((p) => parsedToRecord(projectId, src.path, layer, p));
}

function parsedToRecord(
  projectId: string,
  sourcePath: string,
  layer: MemoryRecord["layer"],
  parsed: ParsedMemory,
): MemoryRecord {
  const now = Date.now();
  return {
    // empty id triggers deterministic id generation in store.normalizeRecord
    id: "",
    projectId,
    layer,
    type: parsed.type,
    sourcePath,
    sourceLine: parsed.sourceLine,
    content: parsed.content,
    tags: parsed.tags,
    importance: parsed.importance,
    createdAt: now,
    updatedAt: now,
  };
}

// silence unused-warn for `join` in builds where it's tree-shaken. We keep
// the import because future task-level checkpointing will need it.
void join;
