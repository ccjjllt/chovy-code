/**
 * Seed 100 fixture memory records into the local store and verify they're
 * all retrievable via `search()`. Used by step-24 §验收 1.
 *
 * Runs against the *real* `~/.chovy/projects/<hash(cwd)>/memory.db` unless
 * `CHOVY_HOME` is overridden in the env. Idempotent: existing records with
 * the same deterministic ids are upserted, not duplicated.
 *
 * Usage: `bun run scripts/seed-memory.ts`
 */

import { createMemoryStore, MEMORY_LAYERS, MEMORY_TYPES } from "../src/memory/index.js";
import { logger } from "../src/logger/index.js";
import type { MemoryRecord } from "../src/types/memory.js";

async function main(): Promise<void> {
  const store = await createMemoryStore({ cwd: process.cwd() });
  const pid = store.projectId;
  const now = Date.now();

  const recs: MemoryRecord[] = [];
  for (let i = 0; i < 100; i++) {
    const layer = MEMORY_LAYERS[i % MEMORY_LAYERS.length];
    const type = MEMORY_TYPES[i % MEMORY_TYPES.length];
    if (!layer || !type) continue;
    recs.push({
      id: `seed_${i.toString(36).padStart(3, "0")}`,
      projectId: pid,
      layer,
      type,
      sourcePath: `seed-memory.ts:${i}`,
      sourceLine: i + 1,
      content: `seed record #${i} (${type}/${layer}) — keyword build benchmark fixture token-${i}`,
      tags: [`seed`, `batch-${Math.floor(i / 10)}`],
      importance: 30 + (i % 70),
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
    });
  }

  await store.upsertMany(recs);

  // Verify every record is retrievable via list (raw) AND search (FTS).
  const allList = await store.list({ projectId: pid, limit: 1000 });
  const seedList = allList.filter((r) => r.id.startsWith("seed_"));
  if (seedList.length !== 100) {
    logger.error(
      `seed-memory: expected 100 records via list(), got ${seedList.length}`,
    );
    store.close();
    process.exit(1);
  }
  logger.info(`seed-memory: list() returned ${seedList.length} / 100 ✔`);

  // FTS search — every record contains the literal "fixture", so a FTS5
  // MATCH for "fixture" must hit all 100 (cap to limit:1000).
  const found = await store.search({ text: "fixture", limit: 1000 });
  const seedFound = found.filter((r) => r.id.startsWith("seed_"));
  if (seedFound.length !== 100) {
    logger.error(
      `seed-memory: search('fixture') returned ${seedFound.length} / 100 (degraded=${store.degraded})`,
    );
    store.close();
    process.exit(1);
  }
  logger.info(`seed-memory: search('fixture') returned ${seedFound.length} / 100 ✔`);

  // Spot-check token search (token-42 → exactly one match).
  const single = await store.search({ text: "token-42" });
  const ids = single.map((r) => r.id);
  if (!ids.includes("seed_16") /* i=42 → 42.toString(36)='16'... wait */) {
    // i=42 → padStart 3,'0' over base36(42)='16' → "016". Recompute the id
    // properly so the spot-check stays hermetic.
    const expected = `seed_${(42).toString(36).padStart(3, "0")}`;
    if (!ids.includes(expected)) {
      logger.error(
        `seed-memory: search('token-42') missed ${expected}; got [${ids.join(", ")}]`,
      );
      store.close();
      process.exit(1);
    }
  }
  logger.info(`seed-memory: search('token-42') hit expected record ✔`);

  logger.info(
    `seed-memory: 100 records seeded into ${store.path}${store.degraded ? " (degraded mode)" : ""}`,
  );
  store.close();
}

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
