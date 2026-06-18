/**
 * Memory store DDL — single source for the SQLite schema (step-24).
 *
 * Why TS instead of `migrations.sql`?
 *   - `bin/chovy.js` is a bundled single-file CLI; shipping a separate
 *     `.sql` resource means either teaching `scripts/build.ts` to copy
 *     non-TS assets or fragile `import.meta.dir` lookups at runtime.
 *   - A TS string constant is its own single source — no risk of `.sql`
 *     and `.ts` copies drifting (which would silently break new
 *     installs while old ones limp along on stale schemas).
 *
 * Schema overview (step-24 §SQLite Schema):
 *
 *   memories          — primary table, one row per record.
 *   memories_fts      — FTS5 virtual table (external content over rowid).
 *   memory_index_meta — file mtime cache for `syncProject()` fast path.
 *
 * Triggers `memories_ai/ad/au` keep `memories_fts` in lockstep with
 * `memories`. Updating either column on `memories` is enough; callers
 * never touch the FTS5 table directly.
 *
 * Tokenizer: `unicode61 remove_diacritics 2` (spec §risks). Folds
 * Unicode case + strips combining marks; insufficient for word-level
 * Chinese segmentation but acceptable as a default — step-24 explicitly
 * defers trigram tokenization as a follow-up.
 */

/**
 * Apply this DDL once per database open. Every statement is `IF NOT EXISTS`
 * so re-running is safe; corruption recovery goes through `rebuild()` which
 * issues `DROP_SQL` first.
 *
 * The runner splits on `;` then trims/skips empties — keep statements
 * simple (no embedded semicolons in strings) so the splitter stays trivial.
 */
export const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_line INTEGER,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project_id, layer, type);
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(project_id, source_path);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS memory_index_meta (
  project_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, source_path)
);

CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (id, version, updated_at) VALUES (1, 1, 0);
`;

/**
 * Drop ALL memory state for `projectId`. Used by `rebuild()`.
 *
 * Important: we DELETE rather than DROP so the FTS5 triggers fire and the
 * external-content FTS table stays consistent. `rebuild()` re-inserts every
 * record from the source files in a single transaction.
 *
 * The placeholder `?` is bound to `projectId` at runtime (never inlined,
 * to keep this constant SQL-injection-safe even though projectIds are
 * generated from a SHA1 hash of cwd).
 */
export const DELETE_PROJECT_SQL = `DELETE FROM memories WHERE project_id = ?;`;

/** Drop the index-meta cache for `projectId` (rebuild force-rescans). */
export const DELETE_PROJECT_META_SQL = `DELETE FROM memory_index_meta WHERE project_id = ?;`;

/** Current schema version. Bump when adding new migrations. */
export const SCHEMA_VERSION = 1;

/**
 * Split MIGRATIONS_SQL into individual statements. Trivial: split on `;`,
 * trim, drop empties. Keep DDL simple to avoid needing a real SQL parser.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ";");
}
