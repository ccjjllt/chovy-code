/**
 * Context rebuilder (step-28 §重建流程).
 *
 * Triggered when the SCW monitor (step-27) crosses the *hard* threshold.
 * Replaces the live conversation history with a structurally rebuilt
 * message list:
 *
 *   1. Append the FULL pre-rebuild messages to `~/.chovy/projects/<id>/
 *      sessions/<sid>.jsonl` (canonical archive — spec line 90-91).
 *   2. Pull the latest checkpoint (step-26 latest.md), top-K memory
 *      (step-24 store.search), active goal progress, and the most
 *      recent K user/assistant turns.
 *   3. Emit a single `<context-rebuilt>` system marker that primes the
 *      assistant with the structured summary, followed by the kept
 *      tail. This new array REPLACES the live history.
 *   4. Fire-and-forget the `ContextRebuilt` advisory hook + emit the
 *      `context.rebuild` telemetry event (single source for that event).
 *   5. Return a `RebuildResult` carrying the new messages, drop counts,
 *      and per-bucket diagnostics for the smoke test / acceptance.
 *
 * Cancellation discipline (AGENTS.md §9 + §22 延续 → §23):
 *   - The caller's `parentSignal` is *observed* only — we never share it
 *     with selectors that own their own AC. Selectors today are
 *     synchronous-ish; if/when they grow long-running fetches, each one
 *     wraps `parentSignal` locally.
 *   - Failure isolation: any selector erroring out degrades to "no entry
 *     for that bucket" + warn; the rebuild proceeds with whatever
 *     buckets did succeed. Worst case (all selectors fail) → fallback
 *     `<rule-summary>` with the recent-K tail and a one-line objective.
 *
 * Single-source rules (AGENTS.md §17/§22 延续 → §23):
 *   - `context.rebuild` telemetry — emitted ONLY here.
 *   - `ContextRebuilt` hook — emitted ONLY here.
 *   - The session JSONL path (`sessionFile()`) is the canonical archive;
 *     no other module is allowed to *truncate* it.
 *   - `ContextBudget` is constructed ONLY via `computeBudget()` (we never
 *     hand-roll a budget object inside this module).
 */

import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { safeFs } from "../fs/safeFs.js";
import { sessionFile, projectId as projectIdOf } from "../fs/paths.js";
import type { ChovyConfig } from "../config/config.js";
import type { ChatMessage } from "../types/messages.js";
import type { ProviderId } from "../types/provider.js";
import type { ContextBudget } from "../types/context.js";
import type { HookEngine } from "../types/hook.js";
import type { MemoryStore } from "../memory/store.js";
import { computeBudget } from "./budgets.js";
import { defaultEstimator } from "./tokenizer.js";
import { recentMessagesPick } from "./selectors/recentMessages.js";
import { checkpointPick } from "./selectors/checkpointPick.js";
import { progressPick } from "./selectors/progressPick.js";
import { memoryPick } from "./selectors/memoryPick.js";

// ── Public surface ─────────────────────────────────────────────────────────

export interface RebuildContextInput {
  /** Live message list at the moment hard threshold fires. */
  messages: ChatMessage[];
  /** Working directory (paths root). */
  cwd: string;
  /** Session id — drives the JSONL archive filename. */
  sessionId: string;
  /** Provider id (PCM single-source for ctx window; passed to budget). */
  provider: ProviderId;
  model: string;
  /** Resolved chovy config (for budget ratios + reserve). */
  cfg: ChovyConfig;
  /** Optional active goal id (for `progress.md` selector + objective). */
  goalId?: string;
  /** Optional active goal objective (rendered in `<task-progress>`). */
  goalObjective?: string;
  /** Token estimate that triggered the rebuild (for telemetry). */
  triggeringTokens: number;
  /** Caller signal — observed only, never re-shared. */
  parentSignal?: AbortSignal;
  /** Hook engine — `ContextRebuilt` advisory fired here. */
  hooks?: HookEngine;
  /** Override store for tests. */
  store?: MemoryStore;
  /** Override budget for tests / future SCW knobs. */
  budgetOverride?: ContextBudget;
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface RebuildContextResult {
  /** The replacement message list (single system marker + kept tail). */
  messages: ChatMessage[];
  /** Pre-rebuild message count. */
  before: number;
  /** Post-rebuild message count (always ≥ 1; the system marker). */
  after: number;
  /** Number of original messages dropped from the live window. */
  dropped: number;
  /** Per-bucket telemetry. */
  buckets: {
    checkpointBytes: number;
    memoryEntries: number;
    progressBytes: number;
    keptMessages: number;
    fallback: boolean;
  };
  /** Estimated total tokens of the rebuilt list. */
  approxTokens: number;
  /** Active budget — exposed for smoke / UI. */
  budget: ContextBudget;
  /** True iff the JSONL append succeeded. */
  archived: boolean;
  archivePath: string;
  durMs: number;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Rebuild a context. Synchronous-ish — selectors are async (file reads +
 * SQL) but we await each in sequence to keep selector failures isolated.
 *
 * The function NEVER throws on individual selector failure: at worst it
 * returns a fallback with `<rule-summary>` + recent K tail.
 */
export async function rebuildContext(
  input: RebuildContextInput,
): Promise<RebuildContextResult> {
  const t0 = Date.now();
  const before = input.messages.length;

  const budget =
    input.budgetOverride ??
    computeBudget(input.model, input.provider, input.cfg, input.env ?? process.env);

  // 1. Archive the original messages BEFORE we touch them. Best-effort:
  //    a write failure must NOT block the rebuild (otherwise a full disk
  //    pinches the entire agent loop). The path is intentionally inside
  //    `~/.chovy/projects/<id>/sessions/` so safeFs guardrails cover it.
  const archivePath = sessionFile(input.cwd, input.sessionId);
  const archived = await archiveMessagesJsonl(
    archivePath,
    input.messages,
    input.sessionId,
  );

  // 2. Pull the latest user prompt — used to drive memory FTS query.
  const latestUserText = lastUserPrompt(input.messages);

  // 3. Run selectors in parallel where independent. memoryPick + progressPick
  //    + checkpointPick + recentMessagesPick don't depend on each other.
  const [cpRes, memRes, progRes, recentRes] = await Promise.all([
    safeCall(() => checkpointPick(input.cwd, budget.checkpoint), "checkpointPick"),
    safeCall(
      () =>
        memoryPick({
          cwd: input.cwd,
          prompt: latestUserText,
          budgetTokens: budget.memory,
          store: input.store,
          projectId: projectIdOf(input.cwd),
        }),
      "memoryPick",
    ),
    safeCall(
      () => progressPick(input.cwd, input.goalId, budget.taskProgress),
      "progressPick",
    ),
    Promise.resolve(
      recentMessagesPick(input.messages, {
        budgetTokens: budget.history,
      }),
    ),
  ]);

  // 4. Determine fallback mode. If we have NEITHER a checkpoint NOR memory
  //    entries, downgrade to the spec's `<rule-summary>` flavor so the
  //    model still sees something structured (line 106-108).
  const haveCheckpoint = !!(cpRes && cpRes.text.trim().length > 0);
  const haveMemory = !!(memRes && memRes.text.trim().length > 0);
  const haveProgress = !!(progRes && progRes.text.trim().length > 0);
  const fallback = !haveCheckpoint && !haveMemory && !haveProgress;

  // 5. Render the system marker.
  const ts = new Date().toISOString();
  const reason = "hard-threshold";
  const markerContent = renderRebuildMarker({
    ts,
    reason,
    fallback,
    objective: input.goalObjective,
    checkpoint: cpRes?.text,
    memory: memRes?.text,
    progress: progRes?.text,
    latestUserText,
  });

  const newMessages: ChatMessage[] = [
    {
      role: "system",
      content: markerContent,
      ts: Date.now(),
    },
    ...recentRes.kept,
  ];

  const approxTokens = defaultEstimator.countMessages(newMessages);

  const buckets = {
    checkpointBytes: cpRes?.bytes ?? 0,
    memoryEntries: memRes?.records.length ?? 0,
    progressBytes: progRes?.bytes ?? 0,
    keptMessages: recentRes.kept.length,
    fallback,
  };

  const durMs = Date.now() - t0;
  const dropped = before - recentRes.kept.length;

  // 6. Telemetry. Single source for `context.rebuild` (AGENTS.md §23).
  emitTelemetry({
    type: "context.rebuild",
    tokens: input.triggeringTokens,
    kept: recentRes.kept.length,
    dropped,
    checkpointBytes: buckets.checkpointBytes,
    memoryEntries: buckets.memoryEntries,
    durMs,
  });

  // 7. Hook advisory — best effort, never fatal.
  if (input.hooks?.emit) {
    try {
      await input.hooks.emit("ContextRebuilt", {
        extra: {
          before,
          after: newMessages.length,
          dropped,
          fallback,
          checkpointBytes: buckets.checkpointBytes,
          memoryEntries: buckets.memoryEntries,
          progressBytes: buckets.progressBytes,
          archivePath: archived ? archivePath : undefined,
        },
      });
    } catch (err) {
      logger.debug("rebuildContext: ContextRebuilt hook threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    messages: newMessages,
    before,
    after: newMessages.length,
    dropped,
    buckets,
    approxTokens,
    budget,
    archived,
    archivePath,
    durMs,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface MarkerInput {
  ts: string;
  reason: string;
  fallback: boolean;
  objective?: string;
  checkpoint?: string;
  memory?: string;
  progress?: string;
  latestUserText: string;
}

/**
 * Compose the `<context-rebuilt>` system marker. Format mirrors the spec
 * verbatim (line 73-83). The fallback path swaps in `<rule-summary>` per
 * spec line 107-108.
 */
function renderRebuildMarker(m: MarkerInput): string {
  const lines: string[] = [];
  lines.push(`<context-rebuilt at="${m.ts}" reason="${m.reason}">`);
  if (m.fallback) {
    lines.push(`<rule-summary>`);
    lines.push(`No checkpoint / memory was available; this is a rule-based`);
    lines.push(`fallback. Last user input: ${truncateOneLine(m.latestUserText, 240)}`);
    if (m.objective) lines.push(`Active goal: ${truncateOneLine(m.objective, 240)}`);
    lines.push(`</rule-summary>`);
  } else {
    if (m.checkpoint && m.checkpoint.trim()) {
      lines.push(`<checkpoint>`);
      lines.push(m.checkpoint.trim());
      lines.push(`</checkpoint>`);
    }
    if (m.memory && m.memory.trim()) {
      lines.push(`<memory>`);
      lines.push(m.memory.trim());
      lines.push(`</memory>`);
    }
    if (m.progress && m.progress.trim()) {
      const objective = m.objective ?? "";
      lines.push(
        `<task-progress${objective ? ` goal="${escapeAttr(objective)}"` : ""}>`,
      );
      lines.push(m.progress.trim());
      lines.push(`</task-progress>`);
    }
  }
  lines.push(
    `<note>之前的对话已截断；请基于上述快照继续；如需查阅旧消息，使用 mem search 工具。</note>`,
  );
  lines.push(`</context-rebuilt>`);
  return lines.join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/\r?\n/g, " ").slice(0, 200);
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = (s ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** Find the last `role:'user'` message and return its content (trimmed). */
function lastUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && m.content) return m.content.trim();
  }
  return "";
}

/**
 * Append every message (one JSON per line) to `path`. Uses safeFs.append
 * which is atomic per-line on POSIX and our single-process invariant.
 *
 * Best-effort: logs and returns false on failure. Callers MUST NOT block
 * the rebuild on archive write.
 */
async function archiveMessagesJsonl(
  path: string,
  messages: ChatMessage[],
  sessionId: string,
): Promise<boolean> {
  if (messages.length === 0) return true;
  const stamp = new Date().toISOString();
  const header = `\n# rebuild ${stamp} session=${sessionId} count=${messages.length}\n`;
  // One JSON object per line — ndjson convention. Header is a comment line
  // (starts with `#`, NOT valid JSON) — readers (chovy log tail / future
  // SessionSearchTool step-30) can skip lines that don't parse as JSON.
  const body = messages
    .map((m) => JSON.stringify({ ...m, _archivedAt: stamp }))
    .join("\n");
  try {
    await safeFs.append(path, header + body + "\n");
    return true;
  } catch (err) {
    logger.warn("rebuildContext: session jsonl append failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Run a selector and return null on throw (logs at debug). */
async function safeCall<T>(
  fn: () => Promise<T | null>,
  label: string,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`rebuildContext: ${label} threw`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
