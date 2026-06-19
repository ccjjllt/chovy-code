import type { AgentRole, MemoryRecord } from "../types/index.js";

export interface MemoryScoreQuery {
  text: string;
  tags?: readonly string[];
  role?: AgentRole;
  now?: number;
}

const LAYER_WEIGHT: Record<MemoryRecord["layer"], number> = {
  project: 1,
  checkpoint: 0.9,
  progress: 0.75,
  notes: 0.55,
};

const TYPE_WEIGHT: Record<MemoryRecord["type"], number> = {
  decision: 1,
  rule: 0.95,
  snapshot: 0.85,
  progress: 0.75,
  fact: 0.7,
  pref: 0.7,
  reference: 0.6,
  note: 0.5,
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function scoreMemoryRecord(
  rec: MemoryRecord,
  query: MemoryScoreQuery,
): number {
  const now = query.now ?? Date.now();
  const bm25 = normalizeSearchScore(rec.score);
  const importance = clamp01(rec.importance / 100);
  const ageMs = Math.max(0, now - rec.updatedAt);
  const recency = Math.exp(-ageMs / THIRTY_DAYS_MS);
  const layer = LAYER_WEIGHT[rec.layer] ?? 0.5;
  const type = TYPE_WEIGHT[rec.type] ?? 0.5;
  const tagBoost = tagOverlap(rec.tags, query.tags ?? []);
  const roleBoost = roleMemoryBoost(rec, query.role);

  return (
    0.4 * bm25 +
    0.2 * importance +
    0.15 * recency +
    0.1 * layer +
    0.1 * type +
    0.05 * tagBoost +
    roleBoost
  );
}

export function compareScoredMemory(
  a: MemoryRecord,
  b: MemoryRecord,
  query: MemoryScoreQuery,
): number {
  const d = scoreMemoryRecord(b, query) - scoreMemoryRecord(a, query);
  if (Math.abs(d) > 0.0001) return d;
  return b.importance - a.importance || b.updatedAt - a.updatedAt;
}

function normalizeSearchScore(score: number | undefined): number {
  if (score === undefined || !Number.isFinite(score)) return 0;
  if (score <= 0) return 0;
  return score / (score + 1);
}

function tagOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bs = new Set(b.map((x) => x.toLowerCase()));
  let hits = 0;
  for (const x of a) if (bs.has(x.toLowerCase())) hits++;
  return clamp01(hits / Math.max(1, b.length));
}

function roleMemoryBoost(rec: MemoryRecord, role: AgentRole | undefined): number {
  if (role === "verifier" && rec.type === "rule") return 0.04;
  if (role === "critic" && rec.type === "decision") return 0.03;
  if (role === "checkpoint-writer" && rec.layer === "checkpoint") return -0.05;
  return 0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
