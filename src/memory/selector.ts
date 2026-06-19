import type { AgentRole, MemoryRecord } from "../types/index.js";
import { compareScoredMemory, scoreMemoryRecord } from "./ranker.js";

export interface SelectMemoryInput {
  records: readonly MemoryRecord[];
  queryText: string;
  budgetTokens: number;
  tags?: readonly string[];
  role?: AgentRole;
  maxPerType?: number;
}

export interface SelectMemoryOutput {
  records: MemoryRecord[];
  totalTokens: number;
  truncated: boolean;
}

export function selectMemoryRecords(input: SelectMemoryInput): SelectMemoryOutput {
  if (input.budgetTokens <= 0 || input.records.length === 0) {
    return { records: [], totalTokens: 0, truncated: input.records.length > 0 };
  }

  const query = {
    text: input.queryText,
    tags: input.tags,
    role: input.role,
  };
  const sorted = [...input.records].sort((a, b) => compareScoredMemory(a, b, query));
  const mandatory = sorted.filter(
    (r) => r.layer === "project" && r.type === "decision" && r.importance >= 80,
  ).slice(0, 3);

  const selected: MemoryRecord[] = [];
  const seen = new Set<string>();
  const byType = new Map<MemoryRecord["type"], number>();
  let total = 0;
  let truncated = false;

  const tryAdd = (rec: MemoryRecord, force = false): void => {
    if (seen.has(rec.id)) return;
    const perType = byType.get(rec.type) ?? 0;
    if (!force && perType >= (input.maxPerType ?? 5)) {
      truncated = true;
      return;
    }
    const tokens = estimateTokens(renderCostText(rec));
    if (total + tokens > input.budgetTokens) {
      if (!force) {
        truncated = true;
        return;
      }
      while (selected.length > 0 && total + tokens > input.budgetTokens) {
        const dropped = selected.pop();
        if (!dropped) break;
        seen.delete(dropped.id);
        total -= estimateTokens(renderCostText(dropped));
        byType.set(dropped.type, Math.max(0, (byType.get(dropped.type) ?? 1) - 1));
      }
    }
    if (total + tokens > input.budgetTokens) {
      truncated = true;
      return;
    }
    selected.push(rec);
    seen.add(rec.id);
    byType.set(rec.type, perType + 1);
    total += tokens;
  };

  for (const rec of mandatory) tryAdd(rec, true);
  for (const rec of sorted) tryAdd(rec);

  selected.sort((a, b) =>
    scoreMemoryRecord(b, query) - scoreMemoryRecord(a, query) ||
    b.importance - a.importance,
  );
  return { records: selected, totalTokens: total, truncated };
}

function renderCostText(rec: MemoryRecord): string {
  return `${rec.layer}/${rec.type}(${rec.importance}): ${rec.content}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4 * 1.2);
}
