import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { MemoryRecord } from "../../src/types/index.js";

const thresholdMs = 10;
const home = mkdtempSync(join(tmpdir(), "chovy-bench-memory-home-"));
const cwd = mkdtempSync(join(tmpdir(), "chovy-bench-memory-cwd-"));
process.env["CHOVY_HOME"] = home;

try {
  const { createMemoryStore } = await import("../../src/memory/index.js");
  const store = await createMemoryStore({ cwd });
  const now = Date.now();
  const rows: MemoryRecord[] = Array.from({ length: 5000 }, (_, i) => ({
    id: `bench_${i}`,
    projectId: store.projectId,
    layer: i % 7 === 0 ? "checkpoint" : i % 5 === 0 ? "notes" : "project",
    type: i % 11 === 0 ? "rule" : i % 13 === 0 ? "decision" : "fact",
    sourcePath: `bench/${i}.md`,
    sourceLine: 1,
    content: `record ${i} describes Bun Ink provider memory integration ${i % 17 === 0 ? "needle" : "context"}`,
    tags: i % 17 === 0 ? ["needle", "bench"] : ["bench"],
    importance: i % 100,
    createdAt: now - i * 1000,
    updatedAt: now - i * 1000,
  }));
  await store.upsertMany(rows);

  const t0 = performance.now();
  const out = await store.search({ text: "needle Bun Ink", ranker: "mixed", limit: 20 });
  const durMs = performance.now() - t0;
  store.close();

  const status = durMs <= thresholdMs ? "PASS" : "WARN";
  console.log(`${status} Memory FTS5 search (5k records): ${durMs.toFixed(2)}ms (threshold ${thresholdMs}ms) rows=${out.length}`);
} finally {
  tryRemove(home);
  tryRemove(cwd);
}

function tryRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Windows may hold SQLite handles briefly after close().
  }
}
