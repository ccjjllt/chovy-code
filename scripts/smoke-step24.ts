/**
 * Step-24 memory store smoke (run with `bun scripts/smoke-step24.ts`).
 *
 * Exercises `docs/step-24-memory-store.md §验收标准` plus the unit-level
 * invariants from §plan §3:
 *
 *  1. types frozen (MemoryLayer / MemoryType unions)
 *  2. parser: frontmatter + 3 bullet shapes + prose fallback
 *  3. parser: layer inference from path
 *  4. store CRUD (upsert / list / remove)
 *  5. store FTS5 search (BM25 ordering)
 *  6. store mixed ranker (BM25 + recency)
 *  7. store rebuild (clear table + repopulate in tx)
 *  8. store rebuild guard: empty projectId throws
 *  9. files/memoryFile: read empty → no-existed; write + read roundtrip
 * 10. files/memoryFile: truncation at 200 lines
 * 11. files/memoryFile: appendMemoryEntry creates section + bullet
 * 12. files/notesFile: appendNote → safeFs.append
 * 13. files/progressFile: tail truncation > 32KB
 * 14. syncFromFiles: incremental (mtime cache)
 * 15. syncFromFiles: forceRebuild from MEMORY.md fixture
 * 16. degraded mode: bun:sqlite probe → InMemoryStore
 * 17. performance baseline: 50KB MEMORY.md parse + index < 500ms
 *     (spec 100ms is on a warm bun:sqlite; we give CI headroom)
 * 18. performance baseline: 1k records FTS search < 50ms
 *     (spec 5ms; CI headroom).
 *
 * All cases run hermetically against a tmp CHOVY_HOME so the user's real
 * project memory.db is never touched.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tmp dir + CHOVY_HOME override (must be set before any home/paths import) ─
const TMP_HOME = join(tmpdir(), `chovy-smoke24-${Date.now().toString(36)}`);
process.env["CHOVY_HOME"] = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

import { ensureHomeDirs, _resetHomeEnsureCacheForTesting } from "../src/fs/home.js";
import { ensureProjectDirs, _resetProjectEnsureCacheForTesting } from "../src/fs/paths.js";
import { isChovyError } from "../src/types/errors.js";
import {
  createMemoryStore,
  parseMemoryDocument,
  inferLayerFromPath,
  syncProject,
  forceRebuild,
  readMemoryFile,
  writeMemoryFile,
  appendMemoryEntry,
  readNotesFile,
  writeNotesFile,
  appendNote,
  readProgressFile,
  appendProgress,
  MAX_MEMORY_LINES,
  MEMORY_LAYERS,
  MEMORY_TYPES,
  _forceInMemoryForTesting,
  _resetSqliteProbeForTesting,
} from "../src/memory/index.js";
import type { MemoryRecord, MemoryLayer, MemoryType } from "../src/types/memory.js";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

ensureHomeDirs();
ensureProjectDirs(process.cwd());
const SMOKE_CWD = process.cwd();

console.log("=== Step-24 memory store smoke ===\n");

// ── 1. types frozen ────────────────────────────────────────────────────────
console.log("[1] types frozen");
{
  check(
    "MEMORY_LAYERS = 4 tiers",
    MEMORY_LAYERS.length === 4 && MEMORY_LAYERS.includes("project") && MEMORY_LAYERS.includes("progress"),
  );
  check(
    "MEMORY_TYPES = 8 types",
    MEMORY_TYPES.length === 8 && MEMORY_TYPES.includes("decision") && MEMORY_TYPES.includes("reference"),
  );
}

// ── 2. parser: frontmatter + 3 bullet shapes + prose fallback ──────────────
console.log("\n[2] parser frontmatter + bullets");
{
  const sample = `---
chovy_memory: true
default_type: decision
default_importance: 60
---

## Architecture

- decision(80): we use Bun + Ink, not Node
- rule(70): commit messages must follow conventional-commits
- production deploy is via GitHub Actions on tag push

## Code style

- rule: prefer explicit return types in TS
- not-a-type: this should fall through to prose default
`;
  const r = parseMemoryDocument(sample);
  check("managed flag set", r.managed);
  check("default_type=decision parsed", r.meta.defaultType === "decision");
  check("default_importance=60 parsed", r.meta.defaultImportance === 60);

  // Find bullets
  const dec = r.records.find((x) => x.content.includes("Bun + Ink"));
  check("full bullet decision(80)", dec?.type === "decision" && dec?.importance === 80);
  const rule = r.records.find((x) => x.content.includes("conventional-commits"));
  check("full bullet rule(70)", rule?.type === "rule" && rule?.importance === 70);
  const bare = r.records.find((x) => x.content.includes("GitHub Actions"));
  check(
    "bare bullet uses default_type/fallback_imp",
    bare?.type === "decision" && bare?.importance === 40,
  );
  const typed = r.records.find((x) => x.content.includes("explicit return types"));
  check(
    "typed bullet uses default_importance",
    typed?.type === "rule" && typed?.importance === 60,
  );
  const fallback = r.records.find((x) => x.content.includes("not-a-type"));
  check(
    "unknown-type bullet → bare path",
    fallback !== undefined && fallback.importance === 40,
  );
  // Tag from section heading
  check(
    "section heading → tag",
    dec?.tags[0] === "architecture",
  );
}

// ── 3. parser: layer inference ─────────────────────────────────────────────
console.log("\n[3] parser layer inference");
{
  check("MEMORY.md → project", inferLayerFromPath("/foo/MEMORY.md") === "project");
  check("notes.md → notes", inferLayerFromPath("/foo/notes.md") === "notes");
  check(
    "checkpoints/x.md → checkpoint",
    inferLayerFromPath("/foo/checkpoints/2026-01.md") === "checkpoint",
  );
  check(
    "tasks/<id>/progress.md → progress",
    inferLayerFromPath("/foo/tasks/abc/progress.md") === "progress",
  );
}

// ── 4. store CRUD ──────────────────────────────────────────────────────────
console.log("\n[4] store CRUD");
{
  _resetSqliteProbeForTesting();
  const store = await createMemoryStore({ cwd: SMOKE_CWD });
  const pid = store.projectId;
  const now = Date.now();
  const rec: MemoryRecord = {
    id: "mem_test_001",
    projectId: pid,
    layer: "project",
    type: "decision",
    sourcePath: "smoke",
    content: "we use bun + ink",
    tags: ["arch"],
    importance: 80,
    createdAt: now,
    updatedAt: now,
  };
  await store.upsert(rec);
  const list1 = await store.list({ projectId: pid });
  check("upsert + list returns row", list1.some((r) => r.id === "mem_test_001"));
  await store.upsert({ ...rec, content: "we use bun + ink (revised)", updatedAt: now + 1 });
  const list2 = await store.list({ projectId: pid });
  const updated = list2.find((r) => r.id === "mem_test_001");
  check("upsert is idempotent (replace content)", updated?.content.includes("revised") === true);
  await store.remove("mem_test_001");
  const list3 = await store.list({ projectId: pid });
  check("remove deletes row", !list3.some((r) => r.id === "mem_test_001"));
  store.close();
}

// ── 5. store FTS5 search (BM25) ────────────────────────────────────────────
console.log("\n[5] FTS5 BM25 search");
let storeForFts = await createMemoryStore({ cwd: SMOKE_CWD });
{
  const pid = storeForFts.projectId;
  const now = Date.now();
  const recs: MemoryRecord[] = [
    "we should build via GitHub Actions",
    "build the binary on tag push",
    "the project uses commitlint for build hooks",
    "unrelated note about logging",
  ].map((c, i) => ({
    id: `fts_${i}`,
    projectId: pid,
    layer: "project" as MemoryLayer,
    type: "fact" as MemoryType,
    sourcePath: "smoke-fts",
    content: c,
    tags: [],
    importance: 50,
    createdAt: now - i * 1000,
    updatedAt: now - i * 1000,
  }));
  await storeForFts.upsertMany(recs);
  const found = await storeForFts.search({ text: "build", limit: 10 });
  check("FTS finds 3 'build' records", found.filter((r) => r.id.startsWith("fts_")).length >= 3);
  const ids = found.filter((r) => r.id.startsWith("fts_")).map((r) => r.id);
  check("FTS does not include unrelated record", !ids.includes("fts_3"));
  // BM25: at least the top result has a numeric score.
  const top = found.find((r) => r.id.startsWith("fts_"));
  check("BM25 score populated", typeof top?.score === "number");
}

// ── 6. mixed ranker ────────────────────────────────────────────────────────
console.log("\n[6] mixed ranker (BM25 + recency)");
{
  const mixed = await storeForFts.search({ text: "build", ranker: "mixed", limit: 10 });
  check("mixed ranker returns rows", mixed.filter((r) => r.id.startsWith("fts_")).length >= 3);
  // Top fts_ result should be the most recent of the matching set (fts_0 was
  // inserted with the largest updatedAt).
  const onlyFts = mixed.filter((r) => r.id.startsWith("fts_"));
  check(
    "mixed ranker biases toward recent",
    onlyFts.length === 0 || onlyFts[0]?.id === "fts_0",
  );
}
storeForFts.close();

// ── 7. rebuild ─────────────────────────────────────────────────────────────
console.log("\n[7] store.rebuild");
{
  const store = await createMemoryStore({ cwd: SMOKE_CWD });
  const pid = store.projectId;
  // Insert 5 throwaway records.
  await store.upsertMany(
    Array.from({ length: 5 }, (_, i) => ({
      id: `rb_${i}`,
      projectId: pid,
      layer: "notes" as MemoryLayer,
      type: "note" as MemoryType,
      sourcePath: "rb",
      content: `rb-${i}`,
      tags: [],
      importance: 50,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  );
  const before = await store.count({ projectId: pid, layer: "notes" });
  check("seeded 5 rb records", before >= 5);
  const r = await store.rebuild(pid, async (insert) => {
    insert({
      id: "rb_new",
      projectId: pid,
      layer: "project",
      type: "fact",
      sourcePath: "rb-fresh",
      content: "freshly rebuilt",
      tags: [],
      importance: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  check("rebuild returned count=1", r.count === 1);
  const after = await store.count({ projectId: pid });
  check("rebuild wiped + repopulated", after === 1);
  store.close();
}

// ── 8. rebuild guard ───────────────────────────────────────────────────────
console.log("\n[8] rebuild empty projectId guard");
{
  const store = await createMemoryStore({ cwd: SMOKE_CWD });
  let threw = false;
  try {
    await store.rebuild("", () => undefined);
  } catch (err) {
    threw = isChovyError(err) && err.code === "MEMORY_INDEX_CORRUPT";
  }
  check("rebuild('') throws MEMORY_INDEX_CORRUPT", threw);
  store.close();
}

// ── 9. memoryFile read/write empty ─────────────────────────────────────────
console.log("\n[9] memoryFile read/write");
{
  const r0 = await readMemoryFile(SMOKE_CWD);
  check("read missing MEMORY.md → existed=false", r0.existed === false && r0.content === "");
  await writeMemoryFile(SMOKE_CWD, "## Roundtrip\n\n- fact: hello\n");
  const r1 = await readMemoryFile(SMOKE_CWD);
  check("read after write → content matches", r1.content.includes("hello"));
  check("read after write → existed=true", r1.existed === true);
}

// ── 10. memoryFile truncation ──────────────────────────────────────────────
console.log("\n[10] memoryFile 200-line truncation");
{
  const lines: string[] = ["## Big"];
  for (let i = 0; i < MAX_MEMORY_LINES + 50; i++) lines.push(`- fact: line ${i}`);
  await writeMemoryFile(SMOKE_CWD, lines.join("\n"));
  const r = await readMemoryFile(SMOKE_CWD);
  check("truncated flag set", r.truncated);
  check("WARNING marker present", r.content.includes("WARNING"));
}

// ── 11. appendMemoryEntry ──────────────────────────────────────────────────
console.log("\n[11] appendMemoryEntry");
{
  await writeMemoryFile(SMOKE_CWD, "");
  await appendMemoryEntry(SMOKE_CWD, {
    section: "Architecture",
    type: "decision",
    importance: 80,
    content: "we use Bun",
  });
  const r1 = await readMemoryFile(SMOKE_CWD);
  check("section header created", r1.content.includes("## Architecture"));
  check("bullet inserted", r1.content.includes("- decision(80): we use Bun"));
  await appendMemoryEntry(SMOKE_CWD, {
    section: "Architecture",
    type: "rule",
    importance: 70,
    content: "no default exports",
  });
  const r2 = await readMemoryFile(SMOKE_CWD);
  check("second bullet appended in same section", r2.content.includes("no default exports"));
  // Confirm only one section header
  const headers = (r2.content.match(/^## Architecture/gm) ?? []).length;
  check("section header NOT duplicated", headers === 1);
}

// ── 12. notesFile ──────────────────────────────────────────────────────────
console.log("\n[12] notesFile append/read");
{
  await writeNotesFile(SMOKE_CWD, "");
  await appendNote(SMOKE_CWD, "first note");
  await appendNote(SMOKE_CWD, "second note");
  const r = await readNotesFile(SMOKE_CWD);
  check("appendNote × 2 → both lines present", r.content.includes("first note") && r.content.includes("second note"));
}

// ── 13. progressFile tail truncation ───────────────────────────────────────
console.log("\n[13] progressFile tail truncation");
{
  const taskId = "smoke-task-1";
  // Write enough progress entries to exceed PROGRESS_TAIL_BYTES (32KB).
  for (let i = 0; i < 1500; i++) {
    await appendProgress(SMOKE_CWD, taskId, `entry ${i} — ${"x".repeat(40)}`);
  }
  const r = await readProgressFile(SMOKE_CWD, taskId);
  check("progress file truncated to tail", r.truncated);
  check("tail starts with NOTE marker", r.content.startsWith("> NOTE"));
  check("byteCount > 32KB", r.byteCount > 32_000);
}

// ── 14. incremental sync (mtime cache) ─────────────────────────────────────
console.log("\n[14] syncProject mtime cache");
{
  const store = await createMemoryStore({ cwd: SMOKE_CWD });
  await writeMemoryFile(
    SMOKE_CWD,
    "## Architecture\n\n- decision(85): bun + ink + zod\n- rule(75): no default exports\n",
  );
  // Reset progress + notes so the incremental sync picks them up too
  await writeNotesFile(SMOKE_CWD, "");
  const r1 = await syncProject(SMOKE_CWD, store);
  check("first sync reindexes ≥1 file", r1.filesReindexed >= 1);
  check("first sync upserts ≥1 record", r1.records >= 2);
  const r2 = await syncProject(SMOKE_CWD, store);
  check("second sync (no mtime change) reindexes 0", r2.filesReindexed === 0);
  store.close();
}

// ── 15. forceRebuild from fixture ──────────────────────────────────────────
console.log("\n[15] forceRebuild from MEMORY.md");
{
  const store = await createMemoryStore({ cwd: SMOKE_CWD });
  const r = await forceRebuild(SMOKE_CWD, store);
  check("forceRebuild count > 0", r.count > 0);
  // Verify we can search the rebuilt index.
  const found = await store.search({ text: "bun" });
  check("FTS finds 'bun' after rebuild", found.length > 0);
  store.close();
}

// ── 16. degraded mode (bun:sqlite missing) ─────────────────────────────────
console.log("\n[16] degraded mode (force in-memory)");
{
  _forceInMemoryForTesting();
  const store = await createMemoryStore({ cwd: SMOKE_CWD });
  check("degraded flag = true", store.degraded === true);
  await store.upsert({
    id: "deg_001",
    projectId: store.projectId,
    layer: "project",
    type: "fact",
    sourcePath: "deg",
    content: "this is a degraded-mode fact about build",
    tags: [],
    importance: 50,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const list = await store.list({ projectId: store.projectId });
  check("degraded list works", list.some((r) => r.id === "deg_001"));
  const search = await store.search({ text: "build" });
  check("degraded search (LIKE fallback) works", search.some((r) => r.id === "deg_001"));
  store.close();
}
// Reset to real probe for any subsequent tests.
_resetSqliteProbeForTesting();

// ── 17. perf baseline: 50KB MEMORY.md parse + index ────────────────────────
console.log("\n[17] perf: 50KB MEMORY.md parse + index");
{
  // Generate ~50KB of bullets (one bullet ~ 60 bytes → ~830 bullets).
  const lines = ["## Big Project", "", "## Stuff"];
  for (let i = 0; i < 800; i++) {
    lines.push(`- fact(${(i % 100)}): bullet ${i} content keyword build benchmark token-${i}`);
  }
  const big = lines.join("\n");
  // Write to a fresh project dir so we don't mix with prior fixtures.
  const PERF_HOME = join(tmpdir(), `chovy-smoke24-perf-${Date.now().toString(36)}`);
  process.env["CHOVY_HOME"] = PERF_HOME;
  mkdirSync(PERF_HOME, { recursive: true });
  _resetHomeEnsureCacheForTesting();
  _resetProjectEnsureCacheForTesting();
  ensureHomeDirs();
  ensureProjectDirs(process.cwd());

  await writeMemoryFile(process.cwd(), big);
  const fileBytes = statSync((await readMemoryFile(process.cwd())).path).size;

  const t0 = Date.now();
  const store = await createMemoryStore({ cwd: process.cwd() });
  const r = await syncProject(process.cwd(), store);
  const dur = Date.now() - t0;
  check(`50KB MEMORY.md parsed (${fileBytes} bytes, ${r.records} records) < 500ms (was ${dur}ms)`, dur < 500);
  store.close();

  // Restore the original CHOVY_HOME for the next case.
  process.env["CHOVY_HOME"] = TMP_HOME;
  _resetHomeEnsureCacheForTesting();
  _resetProjectEnsureCacheForTesting();
  ensureHomeDirs();
  ensureProjectDirs(process.cwd());
}

// ── 18. perf baseline: 1k records FTS search ───────────────────────────────
console.log("\n[18] perf: 1k records FTS search");
{
  // Seed 1k records, then run a search 5× and take the min.
  const PERF_HOME2 = join(tmpdir(), `chovy-smoke24-perf2-${Date.now().toString(36)}`);
  process.env["CHOVY_HOME"] = PERF_HOME2;
  mkdirSync(PERF_HOME2, { recursive: true });
  _resetHomeEnsureCacheForTesting();
  _resetProjectEnsureCacheForTesting();
  ensureHomeDirs();
  ensureProjectDirs(process.cwd());

  const store = await createMemoryStore({ cwd: process.cwd() });
  const pid = store.projectId;
  const now = Date.now();
  const batch: MemoryRecord[] = [];
  for (let i = 0; i < 1000; i++) {
    batch.push({
      id: `perf_${i}`,
      projectId: pid,
      layer: "project",
      type: "fact",
      sourcePath: "perf",
      content: `record ${i} keyword build benchmark token-${i % 100}`,
      tags: ["perf"],
      importance: 30 + (i % 70),
      createdAt: now - i,
      updatedAt: now - i,
    });
  }
  await store.upsertMany(batch);

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const res = await store.search({ text: "build", limit: 50 });
    const d = Date.now() - t;
    if (d < best) best = d;
    if (i === 0 && res.length === 0) {
      // surface failure cause
      console.log(`    (search returned 0; degraded=${store.degraded})`);
    }
  }
  check(`1k FTS search best of 5 < 50ms (was ${best}ms; degraded=${store.degraded})`, best < 50);
  store.close();

  process.env["CHOVY_HOME"] = TMP_HOME;
  _resetHomeEnsureCacheForTesting();
  _resetProjectEnsureCacheForTesting();
}

// ── Cleanup ────────────────────────────────────────────────────────────────
try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
