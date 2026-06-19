/**
 * Memory selector (step-28 §重建流程 step 2).
 *
 * Queries the project's MemoryStore (step-24) for top-K records relevant
 * to the latest user prompt and renders them as a token-budgeted markdown
 * block.
 *
 * Spec line 64: "复用 step-25 selector". step-25 (memory injection) hasn't
 * shipped yet — when it does, it should refactor this file (or an
 * `injection.ts` peer) into a shared selector. Today's contract is
 * narrower: rebuilder-only, called inside the hard-threshold rebuild
 * pipeline, no caching, no relevance dedupe across rounds.
 *
 * Returns `null` when:
 *   - the store is unavailable / errors (degraded path is fine — no entry).
 *   - `prompt` is empty (FTS MATCH on empty string returns nothing useful).
 *   - `budgetTokens ≤ 0`.
 */

import { logger } from "../../logger/index.js";
import { createMemoryStore, type MemoryStore } from "../../memory/store.js";
import type { MemoryQuery, MemoryRecord } from "../../types/memory.js";
import { defaultEstimator } from "../tokenizer.js";

export interface MemoryPickInput {
  cwd: string;
  /** Latest user message text — used as the FTS5 MATCH query. */
  prompt: string;
  /** Token budget for the rendered block. */
  budgetTokens: number;
  /** Optional store override — tests inject an in-memory stub. */
  store?: MemoryStore;
  /** Hard cap on records pulled before token-budgeting. Default 12. */
  topK?: number;
  /** projectId — defaults to the store's projectId. */
  projectId?: string;
}

export interface MemoryPickResult {
  text: string;
  records: MemoryRecord[];
  approxTokens: number;
  /** True when token budget forced us to drop some matched records. */
  truncated: boolean;
}

const DEFAULT_TOP_K = 12;

export async function memoryPick(
  input: MemoryPickInput,
): Promise<MemoryPickResult | null> {
  if (input.budgetTokens <= 0) return null;
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) return null;

  let store: MemoryStore;
  if (input.store) {
    store = input.store;
  } else {
    try {
      store = await createMemoryStore({ cwd: input.cwd });
    } catch (err) {
      logger.warn("memoryPick: store init failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  const projectId = input.projectId ?? store.projectId;
  const query: MemoryQuery = {
    text: prompt.slice(0, 512), // FTS query length cap
    limit: input.topK ?? DEFAULT_TOP_K,
    ranker: "mixed",
  };

  let rows: MemoryRecord[] = [];
  try {
    rows = await store.search(query);
  } catch (err) {
    logger.warn("memoryPick: search threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  // Filter to the active project — `MemoryStore.search` is project-agnostic
  // by default; in degraded mode it returns rows from any project.
  rows = rows.filter((r) => r.projectId === projectId);

  if (rows.length === 0) return null;

  // Render as a flat bullet list, tagging each entry with its layer/type
  // so the model can tell project rules apart from per-task notes.
  const renderEntry = (r: MemoryRecord): string => {
    const tag = `[${r.layer}/${r.type}${
      r.tags.length > 0 ? ` ${r.tags.slice(0, 3).join(",")}` : ""
    }]`;
    const content = (r.content ?? "").replace(/\s+/g, " ").trim();
    return `- ${tag} ${content}`;
  };

  // Greedy fill against the budget.
  const lines: string[] = [];
  const kept: MemoryRecord[] = [];
  let approx = 0;
  let truncated = false;
  for (const r of rows) {
    const line = renderEntry(r);
    const cost = defaultEstimator.countString(line);
    if (approx + cost > input.budgetTokens) {
      truncated = true;
      break;
    }
    lines.push(line);
    kept.push(r);
    approx += cost;
  }

  if (lines.length === 0) {
    // Budget so tight we can't fit even one entry.
    return {
      text: "",
      records: [],
      approxTokens: 0,
      truncated: true,
    };
  }

  return {
    text: lines.join("\n"),
    records: kept,
    approxTokens: approx,
    truncated,
  };
}
