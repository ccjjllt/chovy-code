import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import type { AgentRole, ChatMessage, MemoryRecord } from "../types/index.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { syncProject } from "./syncFromFiles.js";
import { renderMemoryPromptSegment } from "./promptSegment.js";
import { selectMemoryRecords } from "./selector.js";

export interface BuildMemoryPromptSegmentInput {
  cwd: string;
  messages: readonly ChatMessage[];
  budgetTokens: number;
  enabled?: boolean;
  agentRole?: AgentRole;
  goalObjective?: string;
  store?: MemoryStore;
}

export interface BuildMemoryPromptSegmentResult {
  text: string;
  entries: number;
  bytes: number;
  records: MemoryRecord[];
}

const SEARCH_LIMIT = 40;
const FALLBACK_LIMIT = 20;

export async function buildMemoryPromptSegment(
  input: BuildMemoryPromptSegmentInput,
): Promise<BuildMemoryPromptSegmentResult> {
  if (input.enabled === false || input.budgetTokens <= 0) {
    return emptyResult();
  }

  let ownedStore: MemoryStore | undefined;
  const store = input.store ?? await createStore(input.cwd);
  if (!store) return emptyResult();
  if (!input.store) ownedStore = store;

  try {
    await syncProject(input.cwd, store);
    const queryText = latestQueryText(input.messages, input.goalObjective);
    let rows = await searchRows(store, queryText);
    if (rows.length === 0) {
      rows = await store.list({
        projectId: store.projectId,
        limit: FALLBACK_LIMIT,
      });
    }
    rows = rows.filter((r) => r.projectId === store.projectId);

    const selected = selectMemoryRecords({
      records: rows,
      queryText,
      budgetTokens: input.budgetTokens,
      role: input.agentRole,
    });
    const rendered = renderMemoryPromptSegment({
      records: selected.records,
      truncated: selected.truncated,
    });

    emitTelemetry({
      type: "memory.injection",
      bytes: rendered.bytes,
      entries: rendered.entries,
    });
    return {
      text: rendered.text,
      entries: rendered.entries,
      bytes: rendered.bytes,
      records: selected.records,
    };
  } catch (err) {
    logger.warn("memory injection failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyResult();
  } finally {
    ownedStore?.close();
  }
}

async function createStore(cwd: string): Promise<MemoryStore | null> {
  try {
    return await createMemoryStore({ cwd });
  } catch (err) {
    logger.warn("memory injection: store init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function searchRows(
  store: MemoryStore,
  queryText: string,
): Promise<MemoryRecord[]> {
  if (queryText.trim().length === 0) return [];
  try {
    return await store.search({
      text: queryText.slice(0, 512),
      ranker: "mixed",
      limit: SEARCH_LIMIT,
    });
  } catch (err) {
    logger.debug("memory injection: search failed, falling back to list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function latestQueryText(
  messages: readonly ChatMessage[],
  goalObjective: string | undefined,
): string {
  let latest = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m.content.trim().length > 0) {
      latest = m.content;
      break;
    }
  }
  return [goalObjective, latest].filter(Boolean).join("\n").trim();
}

function emptyResult(): BuildMemoryPromptSegmentResult {
  return { text: "", entries: 0, bytes: 0, records: [] };
}
