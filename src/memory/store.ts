/**
 * Memory store — bun:sqlite + FTS5 with graceful in-memory degradation
 * (step-24 §SQLite Schema + §API).
 *
 * Behaviour summary:
 *   - `createMemoryStore({ cwd })` returns a `MemoryStore` instance
 *     bound to `~/.chovy/projects/<hash(cwd)>/memory.db`.
 *   - On Bun targets where `bun:sqlite` is unavailable (some Linux ARM
 *     builds — see step-24 §risks), the factory silently falls back to
 *     an in-memory implementation. A single `memory.index` telemetry
 *     event with `degraded:true` records the downgrade so `chovy log
 *     tail` surfaces it without forcing the agent loop to crash.
 *   - All public methods are async even though `bun:sqlite` is
 *     synchronous — keeps the surface stable if we ever swap in
 *     `better-sqlite3` (Node fallback) or a remote store.
 *
 * Single-source rules (AGENTS.md §16/§17/§18 延续 → §20 step-24):
 *   - DDL  ←  `migrations.ts` (TS string constant; no `.sql` file).
 *   - `MemoryRecord` / `MemoryQuery` ←  `src/types/memory.ts` (B4 frozen).
 *   - `memory.index` telemetry — emitted ONLY here (and `syncFromFiles.ts`
 *     for incremental sync), never from CLI or higher modules.
 */

import { createHash, randomBytes } from "node:crypto";

import { ChovyError } from "../types/errors.js";
import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { memoryDb, projectDir, projectId as projectIdOf } from "../fs/paths.js";
import { ensureProjectDirs } from "../fs/paths.js";
import { ensureHomeDirs } from "../fs/home.js";
import { MEMORY_LAYERS, MEMORY_TYPES } from "../types/memory.js";
import type {
  MemoryLayer,
  MemoryQuery,
  MemoryRecord,
  MemoryType,
} from "../types/memory.js";
import {
  DELETE_PROJECT_META_SQL,
  DELETE_PROJECT_SQL,
  MIGRATIONS_SQL,
} from "./migrations.js";

// ---------------------------------------------------------------------------
// Public API surface (frozen at step-24 §API)
// ---------------------------------------------------------------------------

export interface MemoryStoreListFilter {
  layer?: MemoryLayer;
  type?: MemoryType;
  projectId?: string;
  limit?: number;
}

export interface MemoryStore {
  readonly degraded: boolean;
  readonly path: string;
  readonly projectId: string;
  upsert(rec: MemoryRecord): Promise<void>;
  upsertMany(recs: readonly MemoryRecord[]): Promise<void>;
  remove(id: string): Promise<void>;
  list(filter?: MemoryStoreListFilter): Promise<MemoryRecord[]>;
  search(query: MemoryQuery): Promise<MemoryRecord[]>;
  /**
   * DELETE all rows for `projectId`, then call `repopulate()` (if provided)
   * inside a single transaction. Repopulation is the caller's responsibility
   * — `syncFromFiles.ts` injects it on top of `rebuild()` to do file-driven
   * recovery.
   */
  rebuild(
    projectId: string,
    repopulate?: (insert: (rec: MemoryRecord) => void) => void | Promise<void>,
  ): Promise<{ count: number; degraded: boolean; durMs: number }>;
  /** Test/CLI helpers — not for production hot path. */
  count(filter?: MemoryStoreListFilter): Promise<number>;
  /** Per-source mtime cache used by `syncFromFiles.syncProject`. */
  getIndexedMtime(projectId: string, sourcePath: string): Promise<number | null>;
  setIndexedMtime(
    projectId: string,
    sourcePath: string,
    mtime: number,
  ): Promise<void>;
  /** Drop all records for a single source path (used during incremental sync). */
  removeBySource(projectId: string, sourcePath: string): Promise<void>;
  /** Close the underlying DB handle. Idempotent. */
  close(): void;
}

export interface CreateMemoryStoreOptions {
  cwd: string;
  /** Override for tests; defaults to the canonical `~/.chovy/...` path. */
  dbPath?: string;
}

// ---------------------------------------------------------------------------
// Bun:sqlite type shims — declared here (instead of `import type`) so this
// file can be transpiled on Node targets without complaint. The runtime
// resolution still goes through `await import("bun:sqlite")`.
// ---------------------------------------------------------------------------

interface BunStatement<T = unknown> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
  run(...params: unknown[]): unknown;
  finalize?(): void;
}

interface BunDatabase {
  exec(sql: string): void;
  query<T = unknown>(sql: string): BunStatement<T>;
  prepare<T = unknown>(sql: string): BunStatement<T>;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): void;
  run(sql: string, ...params: unknown[]): unknown;
}

type BunDatabaseCtor = new (filename: string, opts?: { create?: boolean }) => BunDatabase;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cachedCtor: BunDatabaseCtor | null | undefined; // undefined = unprobed

/**
 * Probe `bun:sqlite` once per process. Returns null when unavailable.
 *
 * We use dynamic import so a bundled CLI on Node can still load this module
 * (the bundler keeps `bun:sqlite` external; `await import` on a non-Bun
 * runtime throws and we degrade).
 */
async function loadBunDatabase(): Promise<BunDatabaseCtor | null> {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    const mod = (await import("bun:sqlite")) as { Database: BunDatabaseCtor };
    cachedCtor = mod.Database;
  } catch (err) {
    logger.warn(
      "bun:sqlite unavailable — memory store degraded to in-memory mode (step-24)",
      { err: err instanceof Error ? err.message : String(err) },
    );
    cachedCtor = null;
  }
  return cachedCtor;
}

/**
 * Build a memory store rooted at `cwd`'s project dir. Side effects:
 *   - `ensureHomeDirs()` + `ensureProjectDirs(cwd)` so `memory.db` has a
 *     parent dir to live in.
 *   - One `memory.index` telemetry event of type `init` recording the
 *     starting record count and degraded flag.
 */
export async function createMemoryStore(
  opts: CreateMemoryStoreOptions,
): Promise<MemoryStore> {
  const t0 = Date.now();
  ensureHomeDirs();
  ensureProjectDirs(opts.cwd);
  const path = opts.dbPath ?? memoryDb(opts.cwd);
  const pid = projectIdOf(opts.cwd);

  const Ctor = await loadBunDatabase();
  let store: MemoryStore;
  if (Ctor) {
    try {
      store = await openSqliteStore(Ctor, path, pid);
    } catch (err) {
      logger.warn("memory store: bun:sqlite open failed; degrading to in-memory", {
        path,
        err: err instanceof Error ? err.message : String(err),
      });
      store = openInMemoryStore(path, pid);
    }
  } else {
    store = openInMemoryStore(path, pid);
  }

  // One-shot init telemetry.
  emitTelemetry({
    type: "memory.index",
    projectId: pid,
    op: "init",
    count: await store.count(),
    durMs: Date.now() - t0,
    degraded: store.degraded,
  });

  return store;
}

// ---------------------------------------------------------------------------
// SQLite-backed implementation
// ---------------------------------------------------------------------------

async function openSqliteStore(
  Ctor: BunDatabaseCtor,
  path: string,
  pid: string,
): Promise<MemoryStore> {
  const db = new Ctor(path, { create: true });
  // WAL mode — better concurrent read perf and survives ungraceful exits.
  // FTS5 is built into Bun's bundled sqlite (Bun >= 1.1).
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
  } catch (err) {
    // PRAGMA failures aren't fatal — log + continue. They only impact perf,
    // not correctness.
    logger.debug("memory store: PRAGMA setup warning", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Apply migrations. `db.exec()` accepts multi-statement SQL — we pass the
  // whole DDL block at once because `splitStatements()` is trigger-naïve
  // (it would break on the `;` embedded inside `BEGIN ... END;` bodies).
  // Each individual statement uses `IF NOT EXISTS`, so re-running is safe.
  try {
    db.exec(MIGRATIONS_SQL);
  } catch (err) {
    db.close();
    throw new ChovyError(
      "MEMORY_INDEX_CORRUPT",
      `memory store: migrations failed for ${path}`,
      err,
      { path },
    );
  }

  return makeSqliteStore(db, path, pid);
}

function makeSqliteStore(db: BunDatabase, path: string, pid: string): MemoryStore {
  const upsertSql = `
    INSERT INTO memories (id, project_id, layer, type, source_path, source_line, content, tags, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      layer = excluded.layer,
      type = excluded.type,
      source_path = excluded.source_path,
      source_line = excluded.source_line,
      content = excluded.content,
      tags = excluded.tags,
      importance = excluded.importance,
      updated_at = excluded.updated_at;
  `;

  const insertOne = (rec: MemoryRecord): void => {
    const norm = normalizeRecord(rec);
    db.run(
      upsertSql,
      norm.id,
      norm.projectId,
      norm.layer,
      norm.type,
      norm.sourcePath,
      norm.sourceLine ?? null,
      norm.content,
      JSON.stringify(norm.tags),
      norm.importance,
      norm.createdAt,
      norm.updatedAt,
    );
  };

  const upsertManyTx = db.transaction((recs: readonly MemoryRecord[]) => {
    for (const r of recs) insertOne(r);
  });

  return {
    degraded: false,
    path,
    projectId: pid,

    async upsert(rec) {
      insertOne(rec);
    },

    async upsertMany(recs) {
      if (recs.length === 0) return;
      upsertManyTx(recs);
    },

    async remove(id) {
      db.run("DELETE FROM memories WHERE id = ?", id);
    },

    async removeBySource(projectIdArg, sourcePath) {
      db.run(
        "DELETE FROM memories WHERE project_id = ? AND source_path = ?",
        projectIdArg,
        sourcePath,
      );
    },

    async list(filter = {}) {
      const { sql, params } = buildListSql(filter);
      const rows = db.query<RawRow>(sql).all(...params);
      return rows.map(rowToRecord);
    },

    async search(query) {
      const rows = runSearch(db, query);
      return rows;
    },

    async rebuild(projectIdArg, repopulate) {
      const t0 = Date.now();
      // Tx-level guard: empty projectId would wipe nothing on the WHERE,
      // but we still refuse to be defensive (AGENTS.md §20 invariant 6).
      if (!projectIdArg) {
        throw new ChovyError(
          "MEMORY_INDEX_CORRUPT",
          "rebuild: projectId is required (refusing to no-op or wipe-all)",
        );
      }
      const inserts: MemoryRecord[] = [];
      const collect = (rec: MemoryRecord): void => {
        inserts.push(rec);
      };
      // Collect outside the tx so async repopulate can do I/O without holding
      // the SQLite write lock.
      if (repopulate) await repopulate(collect);

      const tx = db.transaction(() => {
        db.run(DELETE_PROJECT_SQL, projectIdArg);
        db.run(DELETE_PROJECT_META_SQL, projectIdArg);
        for (const r of inserts) insertOne(r);
      });
      tx();

      const after = Number(
        (db.query<{ c: number }>("SELECT COUNT(*) as c FROM memories WHERE project_id = ?")
          .get(projectIdArg) ?? { c: 0 }).c,
      );
      const durMs = Date.now() - t0;
      emitTelemetry({
        type: "memory.index",
        projectId: projectIdArg,
        op: "rebuild",
        count: after,
        durMs,
        degraded: false,
      });
      return { count: after, degraded: false, durMs };
    },

    async count(filter = {}) {
      const { sql, params } = buildListSql(filter, /*forCount=*/ true);
      const row = db.query<{ c: number }>(sql).get(...params);
      return Number(row?.c ?? 0);
    },

    async getIndexedMtime(projectIdArg, sourcePath) {
      const row = db
        .query<{ mtime: number }>(
          "SELECT mtime FROM memory_index_meta WHERE project_id = ? AND source_path = ?",
        )
        .get(projectIdArg, sourcePath);
      return row ? Number(row.mtime) : null;
    },

    async setIndexedMtime(projectIdArg, sourcePath, mtime) {
      db.run(
        `INSERT INTO memory_index_meta (project_id, source_path, mtime, indexed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, source_path) DO UPDATE SET
           mtime = excluded.mtime,
           indexed_at = excluded.indexed_at;`,
        projectIdArg,
        sourcePath,
        mtime,
        Date.now(),
      );
    },

    close(): void {
      try {
        db.close();
      } catch {
        /* idempotent */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Query / list builders (shared SQL shape)
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  project_id: string;
  layer: string;
  type: string;
  source_path: string;
  source_line: number | null;
  content: string;
  tags: string;
  importance: number;
  created_at: number;
  updated_at: number;
  rank?: number;
}

function rowToRecord(row: RawRow): MemoryRecord {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* leave empty on bad json */
  }
  const rec: MemoryRecord = {
    id: row.id,
    projectId: row.project_id,
    layer: row.layer as MemoryLayer,
    type: row.type as MemoryType,
    sourcePath: row.source_path,
    content: row.content,
    tags,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.source_line !== null && row.source_line !== undefined) {
    rec.sourceLine = row.source_line;
  }
  return rec;
}

function buildListSql(
  filter: MemoryStoreListFilter,
  forCount = false,
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.layer) {
    where.push("layer = ?");
    params.push(filter.layer);
  }
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  if (forCount) {
    return { sql: `SELECT COUNT(*) as c FROM memories${whereSql}`, params };
  }
  const limit = clampLimit(filter.limit);
  return {
    sql: `SELECT * FROM memories${whereSql} ORDER BY importance DESC, updated_at DESC LIMIT ${limit}`,
    params,
  };
}

const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Run a `MemoryQuery` against the SQLite-backed store. Returns ranked
 * records (with `score` populated when a `text` term was supplied).
 *
 * Branching:
 *   - With `text`: JOIN against `memories_fts` MATCH; rank with `bm25()`,
 *     optionally mixed with a recency factor.
 *   - Without `text`: plain WHERE on importance/layer/type.
 */
function runSearch(db: BunDatabase, query: MemoryQuery): MemoryRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.layers && query.layers.length > 0) {
    where.push(`layer IN (${query.layers.map(() => "?").join(",")})`);
    for (const l of query.layers) params.push(l);
  }
  if (query.types && query.types.length > 0) {
    where.push(`type IN (${query.types.map(() => "?").join(",")})`);
    for (const t of query.types) params.push(t);
  }
  if (typeof query.minImportance === "number") {
    where.push(`importance >= ?`);
    params.push(query.minImportance);
  }
  if (typeof query.since === "number") {
    where.push(`created_at >= ?`);
    params.push(query.since);
  }

  const limit = clampLimit(query.limit);

  if (query.text && query.text.trim().length > 0) {
    const ftsTerm = sanitizeFtsQuery(query.text);
    const ranker = query.ranker ?? "bm25";
    // bm25 returns negative numbers (lower = better); we negate to keep "higher
    // score = better" everywhere downstream.
    if (ranker === "mixed") {
      // recency = exp(-(now - updated_at) / 30d). Use SQLite's exp() — Bun's
      // sqlite ships with the math extension. `mixed_score = 0.7 * (-bm25) +
      // 0.3 * recency_norm`.
      const sql = `
        SELECT m.*, (-bm25(memories_fts)) AS bm25_score,
               (CASE WHEN ? - m.updated_at < 0 THEN 1.0
                     ELSE exp(-(CAST(? - m.updated_at AS REAL) / ?))
                END) AS recency_score
          FROM memories m
          JOIN memories_fts f ON f.rowid = m.rowid
         WHERE memories_fts MATCH ? ${where.length ? "AND " + where.join(" AND ") : ""}
         ORDER BY (0.7 * (-bm25(memories_fts)) + 0.3 *
                   (CASE WHEN ? - m.updated_at < 0 THEN 1.0
                         ELSE exp(-(CAST(? - m.updated_at AS REAL) / ?))
                    END)) DESC
         LIMIT ${limit}
      `;
      const now = Date.now();
      const allParams: unknown[] = [
        now,
        now,
        RECENCY_WINDOW_MS,
        ftsTerm,
        ...params,
        now,
        now,
        RECENCY_WINDOW_MS,
      ];
      let rows: (RawRow & { bm25_score: number; recency_score: number })[] = [];
      try {
        rows = db
          .query<RawRow & { bm25_score: number; recency_score: number }>(sql)
          .all(...allParams);
      } catch (err) {
        // exp() not present (older bundled sqlite) → fall back to bm25 only.
        logger.debug("memory.search: exp() unavailable, falling back to bm25", {
          err: err instanceof Error ? err.message : String(err),
        });
        return runBm25(db, ftsTerm, where, params, limit);
      }
      return rows.map((row) => {
        const rec = rowToRecord(row);
        rec.score = 0.7 * Number(row.bm25_score) + 0.3 * Number(row.recency_score);
        return rec;
      });
    }
    return runBm25(db, ftsTerm, where, params, limit);
  }

  // No FTS term → plain ORDER BY importance/updated.
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .query<RawRow>(
      `SELECT * FROM memories${whereSql} ORDER BY importance DESC, updated_at DESC LIMIT ${limit}`,
    )
    .all(...params);
  return rows.map(rowToRecord);
}

function runBm25(
  db: BunDatabase,
  ftsTerm: string,
  where: string[],
  params: unknown[],
  limit: number,
): MemoryRecord[] {
  const sql = `
    SELECT m.*, (-bm25(memories_fts)) AS rank
      FROM memories m
      JOIN memories_fts f ON f.rowid = m.rowid
     WHERE memories_fts MATCH ? ${where.length ? "AND " + where.join(" AND ") : ""}
     ORDER BY rank DESC
     LIMIT ${limit}
  `;
  const rows = db
    .query<RawRow & { rank: number }>(sql)
    .all(ftsTerm, ...params);
  return rows.map((row) => {
    const rec = rowToRecord(row);
    rec.score = Number(row.rank);
    return rec;
  });
}

/**
 * Sanitize a free-text query for FTS5 MATCH.
 *
 * FTS5 has a tiny query DSL (NEAR, AND/OR/NOT, prefix `*`, phrases `"…"`).
 * Naive user input often contains characters that crash the parser; we
 * tokenize on whitespace and quote each token so phrases stay as phrases
 * and stray operators are neutralized.
 */
function sanitizeFtsQuery(text: string): string {
  const tokens = text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `"${s.replace(/"/g, '""')}"`);
  return tokens.join(" ");
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 50;
  if (limit <= 0) return 50;
  if (limit > 1000) return 1000;
  return Math.floor(limit);
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

function normalizeRecord(rec: MemoryRecord): MemoryRecord {
  if (!rec.projectId) {
    throw new ChovyError("MEMORY_IO", "memory.upsert: projectId is required", undefined, {
      record: rec.id,
    });
  }
  if (!MEMORY_LAYERS.includes(rec.layer)) {
    throw new ChovyError(
      "MEMORY_IO",
      `memory.upsert: unknown layer "${rec.layer}"`,
      undefined,
      { layer: rec.layer },
    );
  }
  if (!MEMORY_TYPES.includes(rec.type)) {
    throw new ChovyError(
      "MEMORY_IO",
      `memory.upsert: unknown type "${rec.type}"`,
      undefined,
      { type: rec.type },
    );
  }
  const now = Date.now();
  const id = rec.id || generateId(rec.projectId, rec.sourcePath, rec.sourceLine, rec.content);
  const importance = clampImportance(rec.importance ?? 50);
  const tags = Array.isArray(rec.tags) ? rec.tags.filter((t) => typeof t === "string") : [];
  return {
    ...rec,
    id,
    importance,
    tags,
    createdAt: rec.createdAt > 0 ? rec.createdAt : now,
    updatedAt: rec.updatedAt > 0 ? rec.updatedAt : now,
  };
}

function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 50;
  const i = Math.round(n);
  if (i < 0) return 0;
  if (i > 100) return 100;
  return i;
}

/**
 * Generate a stable id from `(projectId, sourcePath, sourceLine, contentHash)`
 * so re-parsing the same source produces the same id (idempotent upsert).
 *
 * Falls back to `'mem_' + base36(rand)` when the content/source combo is
 * empty (e.g. callers forming records from non-file sources).
 */
function generateId(
  projectId: string,
  sourcePath: string,
  sourceLine: number | undefined,
  content: string,
): string {
  const seed = `${projectId}|${sourcePath}|${sourceLine ?? ""}|${content}`;
  if (!sourcePath || !content) {
    return "mem_" + randomBytes(6).toString("hex");
  }
  const h = createHash("sha1").update(seed).digest("hex").slice(0, 12);
  return `mem_${h}`;
}

// ---------------------------------------------------------------------------
// In-memory fallback (bun:sqlite missing)
// ---------------------------------------------------------------------------

function openInMemoryStore(path: string, pid: string): MemoryStore {
  const rows = new Map<string, MemoryRecord>();
  const meta = new Map<string, number>(); // key = `${projectId}\u0000${sourcePath}`

  const metaKey = (p: string, s: string): string => `${p}\u0000${s}`;

  const matchesText = (rec: MemoryRecord, text: string): boolean => {
    const needle = text.toLowerCase();
    if (rec.content.toLowerCase().includes(needle)) return true;
    return rec.tags.some((t) => t.toLowerCase().includes(needle));
  };

  return {
    degraded: true,
    path,
    projectId: pid,

    async upsert(rec) {
      const norm = normalizeRecord(rec);
      rows.set(norm.id, norm);
    },

    async upsertMany(recs) {
      for (const r of recs) rows.set(normalizeRecord(r).id, normalizeRecord(r));
    },

    async remove(id) {
      rows.delete(id);
    },

    async removeBySource(projectIdArg, sourcePath) {
      for (const [id, r] of rows) {
        if (r.projectId === projectIdArg && r.sourcePath === sourcePath) rows.delete(id);
      }
    },

    async list(filter = {}) {
      const xs = Array.from(rows.values()).filter((r) => {
        if (filter.projectId && r.projectId !== filter.projectId) return false;
        if (filter.layer && r.layer !== filter.layer) return false;
        if (filter.type && r.type !== filter.type) return false;
        return true;
      });
      xs.sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
      return xs.slice(0, clampLimit(filter.limit));
    },

    async search(query) {
      let xs = Array.from(rows.values());
      if (query.layers && query.layers.length > 0) {
        xs = xs.filter((r) => query.layers!.includes(r.layer));
      }
      if (query.types && query.types.length > 0) {
        xs = xs.filter((r) => query.types!.includes(r.type));
      }
      if (typeof query.minImportance === "number") {
        xs = xs.filter((r) => r.importance >= query.minImportance!);
      }
      if (typeof query.since === "number") {
        xs = xs.filter((r) => r.createdAt >= query.since!);
      }
      if (query.text && query.text.trim().length > 0) {
        const text = query.text;
        xs = xs.filter((r) => matchesText(r, text));
        // Degraded mode: rank by `importance + (mention count * 5)` so
        // callers still get *some* relevance signal. Not BM25 quality but
        // good enough for the rare ARM-Linux fallback path.
        const needle = text.toLowerCase();
        xs.sort((a, b) => {
          const aScore =
            a.importance + countOccurrences(a.content.toLowerCase(), needle) * 5;
          const bScore =
            b.importance + countOccurrences(b.content.toLowerCase(), needle) * 5;
          return bScore - aScore;
        });
        for (const r of xs) {
          r.score = countOccurrences(r.content.toLowerCase(), needle);
        }
      } else {
        xs.sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
      }
      return xs.slice(0, clampLimit(query.limit));
    },

    async rebuild(projectIdArg, repopulate) {
      const t0 = Date.now();
      if (!projectIdArg) {
        throw new ChovyError(
          "MEMORY_INDEX_CORRUPT",
          "rebuild: projectId is required (refusing to no-op or wipe-all)",
        );
      }
      for (const [id, r] of rows) {
        if (r.projectId === projectIdArg) rows.delete(id);
      }
      for (const k of Array.from(meta.keys())) {
        if (k.startsWith(projectIdArg + "\u0000")) meta.delete(k);
      }
      if (repopulate) {
        await repopulate((rec) => {
          const norm = normalizeRecord(rec);
          rows.set(norm.id, norm);
        });
      }
      const count = Array.from(rows.values()).filter(
        (r) => r.projectId === projectIdArg,
      ).length;
      const durMs = Date.now() - t0;
      emitTelemetry({
        type: "memory.index",
        projectId: projectIdArg,
        op: "rebuild",
        count,
        durMs,
        degraded: true,
      });
      return { count, degraded: true, durMs };
    },

    async count(filter = {}) {
      return (await this.list({ ...filter, limit: 1_000_000 })).length;
    },

    async getIndexedMtime(projectIdArg, sourcePath) {
      const v = meta.get(metaKey(projectIdArg, sourcePath));
      return v ?? null;
    },

    async setIndexedMtime(projectIdArg, sourcePath, mtime) {
      meta.set(metaKey(projectIdArg, sourcePath), mtime);
    },

    close(): void {
      /* no-op */
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Force the next `createMemoryStore()` call to re-probe `bun:sqlite`. */
export function _resetSqliteProbeForTesting(): void {
  cachedCtor = undefined;
}

/** Force the next `createMemoryStore()` call to take the in-memory path. */
export function _forceInMemoryForTesting(): void {
  cachedCtor = null;
}

/** Reusable helper for callers that just want the project root path. */
export function memoryProjectDir(cwd: string): string {
  return projectDir(cwd);
}
