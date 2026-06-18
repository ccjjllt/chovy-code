/**
 * CheckpointCoordinator (step-26).
 *
 * Owns the *when*, *where*, and *how* of structured session checkpoints.
 * The checkpoint-writer sub-agent (defined at
 * `src/agent/builtin/checkpointWriterAgent.ts`) only owns the *what* — it
 * generates the markdown body. This split lets the coordinator centralize:
 *
 *   - debouncing (30s per reason),
 *   - archive rotation (≤ MAX_ARCHIVE_FILES files in the dir),
 *   - validation (size cap; truncation; non-empty body),
 *   - rule-based fallback when the agent fails or is cancelled,
 *   - hook + telemetry emission (single source per AGENTS.md §17).
 *
 * Triggers (`reason`) — OR'd, all share the same pipeline:
 *
 *   - `goal-round`   — `runGoal` every `CHECKPOINT_INTERVAL_ROUNDS` rounds
 *                      (step-23 / `src/goals/checkpoint.ts`).
 *   - `manual`       — user typed `/checkpoint now` (REPL slash command).
 *   - `session-end`  — REPL exit / `chovy chat` finishes (TODO step-26+).
 *   - `token-soft`   — SCW (step-27/28) sees ctx > soft threshold
 *                      (entry point reserved; coordinator already accepts it).
 *   - `big-event`    — large dispatch / long bash / mass edit
 *                      (entry point reserved; same as `token-soft`).
 *
 * Path layout (`src/fs/paths.ts`):
 *   ~/.chovy/projects/<hash(cwd)>/checkpoints/
 *     ├── latest.md                           ← always overwritten
 *     └── 2026-06-18T10-30-00-000Z.md         ← timestamped archive
 *
 * Path sandbox (defense in depth):
 *   1. The agent's `allowedTools` only includes `file_read` / `file_write`.
 *   2. `tools/fs/write.ts` + `tools/fs/edit.ts` deny paths outside the
 *      checkpoint dir when `ctx.agentRole === "checkpoint-writer"`
 *      (step-26 ToolContext.agentRole field + `isWithin(checkpointDir, p)`).
 *   3. The coordinator validates the artifact post-write (size, presence,
 *      truncates to 8 KB if oversized).
 *   4. Rotation is performed by the coordinator (not the agent), so the
 *      role can never delete user files even via `safeFs.remove` (which is
 *      itself confined to `~/.chovy` already).
 *
 * Cancellation (AGENTS.md §9 + §16):
 *   - The coordinator wraps the caller's `parentSignal` in a *local*
 *     AbortController; the spawned sub-agent gets that local signal so
 *     cancelling the goal cancels the in-flight checkpoint write without
 *     sharing the parent signal object.
 *   - Caller code (`triggerCheckpoint`) wraps `await maybeCheckpoint(...)`
 *     in `void` so the goal loop is never blocked.
 */

import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import {
  safeFs,
  isWithin,
  checkpointDir,
  latestCheckpointFile,
  ensureProjectDirs,
} from "../fs/index.js";
// Reach the leaf `agent/pool.js` rather than the `agent/index` barrel: the
// barrel re-exports `runAgent` whose top-level `setSpawnFnBuilder(...)`
// call closes the engine → memory → agent → engine cycle (TDZ on the
// registry's `let spawnFnBuilder`). Same DAG discipline as
// `swarm/pool.ts → agent/pool.js` (AGENTS.md §18).
import {
  getSubAgentPool,
  type SubAgentPool,
} from "../agent/pool.js";
import type {
  ChatMessage,
  GoalHistoryEntry,
  HookEngine,
  ParentRuntimeCtx,
  ProviderId,
  SubAgentHandle,
} from "../types/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Per-reason debounce window. Two consecutive triggers with the same
 *  `reason` within this window collapse to one. Different reasons are
 *  independent (they may legitimately fire close together — e.g. /goal
 *  hits a round boundary AND the user types /checkpoint now). */
export const DEBOUNCE_WINDOW_MS = 30_000;

/** Hard archive cap. The coordinator deletes the oldest .md files in the
 *  checkpoint dir until count ≤ MAX_ARCHIVE_FILES. `latest.md` is excluded
 *  from the count. */
export const MAX_ARCHIVE_FILES = 50;

/** Per-spec line 63: "不要超过 8KB". Coordinator truncates oversized agent
 *  output. Truncation marker leaves head + tail visible. */
export const MAX_CHECKPOINT_BYTES = 8 * 1024;

/** Spawn budget — checkpoint writes are mechanical; small model + cap. */
const SPAWN_BUDGET_USD = 0.05;
const SPAWN_TIMEOUT_MS = 30_000;
const SPAWN_MAX_ROUNDS = 4;

// ── Public types ───────────────────────────────────────────────────────────

export type CheckpointReason =
  | "goal-round"
  | "manual"
  | "session-end"
  | "token-soft"
  | "big-event";

export interface CheckpointInput {
  cwd: string;
  /** Current `/goal` objective; `'ad-hoc'` when running outside /goal. */
  objective?: string;
  /** Recent K parent messages for the agent to summarize. */
  recentMessages?: ChatMessage[];
  /** Tail of `goal.history` (last 5 entries by convention). */
  historyTail?: GoalHistoryEntry[];
  /** Provider for the spawn (defaults to caller's). Required so the spawn
   *  can be issued — the role's `preferredModel` is used unless overridden. */
  provider: ProviderId;
  model?: string;
  /** Caller signal — coordinator wraps in a local AC before spawning. */
  parentSignal?: AbortSignal;
  /** REPL thread id (or any caller-defined session id) — ends up on the
   *  parent ctx so `subagent.spawn` events trace back correctly. */
  threadId?: string;
  /** Parent role (so the spawn's parentCtx is well-formed). Defaults to
   *  "main" when running from the REPL / goal loop. */
  parentRole?: import("../types/agent.js").AgentRole;
}

export interface CheckpointResult {
  /** True when at least latest.md was written (agent or fallback). */
  ok: boolean;
  /** Resolved reason — `'debounced'` when the call was suppressed. */
  reason: CheckpointReason | "debounced";
  /** Absolute path to `latest.md` (always set on `ok:true`). */
  latestPath?: string;
  /** Absolute path to the timestamped archive copy (when written). */
  archivePath?: string;
  /** Bytes written to `latest.md` (post-truncation). */
  bytes?: number;
  /** Was the body produced by the agent or by the rule-based fallback? */
  mode?: "agent" | "fallback";
  /** USD cost of the spawn (advisory; cost-tracker is a separate accounting). */
  costUSD?: number;
  /** Wall-clock ms from invocation to write. */
  durMs?: number;
  /** Set when `ok:false`. */
  error?: string;
}

// ── Coordinator ────────────────────────────────────────────────────────────

export interface CheckpointCoordinatorDeps {
  /** Override the live pool (tests inject a stub). */
  pool?: SubAgentPool;
  /** Hooks engine — the coordinator emits `CheckpointWritten` advisory. */
  hooks?: HookEngine;
  /** Clock — tests can advance debounce manually. */
  now?: () => number;
}

export class CheckpointCoordinator {
  private readonly debounce = new Map<CheckpointReason, number>();
  private readonly deps: CheckpointCoordinatorDeps;

  constructor(deps: CheckpointCoordinatorDeps = {}) {
    this.deps = deps;
  }

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  private pool(): SubAgentPool {
    return this.deps.pool ?? getSubAgentPool();
  }

  /**
   * The single entry point. Idempotent / debounced. Caller wraps in `void`
   * to fire-and-forget; on the goal-loop hot path this never blocks.
   */
  async maybeCheckpoint(
    reason: CheckpointReason,
    input: CheckpointInput,
  ): Promise<CheckpointResult> {
    const t0 = this.clock();

    // 1. Debounce ─────────────────────────────────────────────────────────
    const last = this.debounce.get(reason);
    if (last !== undefined && t0 - last < DEBOUNCE_WINDOW_MS) {
      logger.debug("checkpoint: debounced", {
        reason,
        ageMs: t0 - last,
      });
      return { ok: false, reason: "debounced" };
    }
    // Pre-stamp so concurrent triggers within the window also collapse.
    this.debounce.set(reason, t0);

    // 2. Ensure project dirs exist (idempotent) ────────────────────────────
    try {
      await ensureProjectDirs(input.cwd);
    } catch (err) {
      logger.warn("checkpoint: ensureProjectDirs failed", {
        cwd: input.cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue — safeFs.write will create parents anyway.
    }

    const dir = checkpointDir(input.cwd);
    const latest = latestCheckpointFile(input.cwd);
    const tsForArchive = new Date(t0).toISOString().replace(/[:.]/g, "-");
    const archive = `${dir}/${tsForArchive}.md`;

    // 3. Local AbortController — never share parent signal (AGENTS.md §9).
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (input.parentSignal) {
      if (input.parentSignal.aborted) {
        ac.abort();
      } else {
        input.parentSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let mode: "agent" | "fallback" = "agent";
    let body: string | null = null;
    let costUSD = 0;
    let spawnError: string | undefined;

    // 4. Spawn the checkpoint-writer ───────────────────────────────────────
    if (!ac.signal.aborted) {
      try {
        const handle = await this.spawnWriter(input, latest, ac.signal);
        body = extractFinalMarkdown(handle);
        costUSD = handle.costUSD;
        if (handle.status !== "done" || !body || body.trim().length === 0) {
          mode = "fallback";
          spawnError =
            handle.result?.reason ??
            (handle.status === "cancelled"
              ? "spawn cancelled"
              : "agent produced empty body");
          body = null;
        }
      } catch (err) {
        spawnError = err instanceof Error ? err.message : String(err);
        logger.warn("checkpoint: spawn threw", {
          cwd: input.cwd,
          reason,
          error: spawnError,
        });
        mode = "fallback";
        body = null;
      }
    } else {
      mode = "fallback";
      spawnError = "cancelled before spawn";
    }

    // 5. Fallback path ─────────────────────────────────────────────────────
    if (body === null) {
      body = buildFallbackMarkdown(input, t0, spawnError);
    }

    // 6. Truncate if oversized ─────────────────────────────────────────────
    let bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_CHECKPOINT_BYTES) {
      body = truncateBody(body, MAX_CHECKPOINT_BYTES);
      bytes = Buffer.byteLength(body, "utf8");
      logger.warn("checkpoint: body truncated", {
        cwd: input.cwd,
        originalBytes: bytes,
      });
    }

    // 7. Sandbox check (belt-and-suspenders): write paths must live under
    //    the checkpoint dir. The coordinator owns the path computation, so
    //    this is paranoia, not policy — but cheap to keep honest.
    if (!isWithin(dir, latest) || !isWithin(dir, archive)) {
      input.parentSignal?.removeEventListener?.("abort", onAbort);
      return {
        ok: false,
        reason,
        error: "internal: computed write path escaped checkpoint dir",
      };
    }

    // 8. Atomic write (latest + archive). Failures are logged but never
    //    thrown back to the caller (per spec §性能: "失败时 telemetry warn").
    let writeError: string | undefined;
    try {
      await safeFs.write(latest, body);
    } catch (err) {
      writeError = err instanceof Error ? err.message : String(err);
      logger.warn("checkpoint: write latest.md failed", {
        path: latest,
        error: writeError,
      });
    }
    if (!writeError) {
      try {
        await safeFs.write(archive, body);
      } catch (err) {
        // Archive failure is non-fatal — latest.md is the canonical artifact.
        logger.warn("checkpoint: write archive failed", {
          path: archive,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 9. Rotate archive (best-effort). ─────────────────────────────────────
    try {
      await rotateArchive(input.cwd, MAX_ARCHIVE_FILES);
    } catch (err) {
      logger.warn("checkpoint: rotate failed", {
        cwd: input.cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 10. Hook + telemetry. Single source for `checkpoint.written` is
    //     this coordinator (AGENTS.md §17 mirrors `agent.cost` /
    //     `swarm.dispatch`). Hook is advisory + best-effort.
    const durMs = this.clock() - t0;
    if (!writeError) {
      try {
        if (this.deps.hooks?.emit) {
          await this.deps.hooks.emit("CheckpointWritten", {
            extra: {
              path: latest,
              bytes,
              reason,
              mode,
            },
          });
        }
      } catch {
        /* hooks are advisory — never fatal */
      }
      emitTelemetry({
        type: "checkpoint.written",
        path: latest,
        bytes,
        reason,
        mode,
        durMs,
      });
    }

    // 11. Detach abort listener.
    input.parentSignal?.removeEventListener?.("abort", onAbort);

    // NOTE: checkpoint → MemoryStore indexing happens via step-24's
    // file-primary sync path, NOT a direct upsert here. `syncFromFiles`
    // treats `checkpoints/*.md` as a layer=checkpoint source and parses +
    // upserts them (verified by smoke-step26 §13). The filesystem is the
    // primary source; the store is a derived index (step-24 §文件 ↔ DB 同步),
    // so the coordinator does not need to upsert again after writing. A
    // direct call here would only be a micro-optimisation (skip one mtime
    // probe on the next sync) — left to step-25/27 if the hot path needs it.

    if (writeError) {
      return {
        ok: false,
        reason,
        error: writeError,
        durMs,
        costUSD,
      };
    }
    return {
      ok: true,
      reason,
      latestPath: latest,
      archivePath: archive,
      bytes,
      mode,
      costUSD,
      durMs,
    };
  }

  /**
   * Reset debounce state (tests + smoke). Production callers never need
   * this — the coordinator is per-process and the debounce window is small.
   */
  _resetDebounceForTesting(): void {
    this.debounce.clear();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async spawnWriter(
    input: CheckpointInput,
    latestPath: string,
    signal: AbortSignal,
  ): Promise<SubAgentHandle> {
    const parentCtx: ParentRuntimeCtx = {
      parentId: input.threadId ?? `coordinator_${this.clock().toString(36)}`,
      parentRole: input.parentRole ?? "main",
      parentProvider: input.provider,
      parentModel: input.model ?? "",
      parentMessages: input.recentMessages ?? [],
      parentSignal: signal,
      parentObjective: input.objective,
    };

    const prompt = buildSnapshotPrompt({
      objective: input.objective ?? "ad-hoc",
      recentMessages: input.recentMessages ?? [],
      historyTail: input.historyTail ?? [],
      latestPath,
      cwd: input.cwd,
    });

    return this.pool().spawn(
      {
        role: "checkpoint-writer",
        prompt,
        // Disable session sharing — we already inject the relevant context
        // via the prompt; the live snapshot would only inflate the spawn
        // (and could leak parent secrets the writer doesn't need).
        shareSession: false,
        background: false,
        provider: input.provider,
        model: input.model,
        budgetUSD: SPAWN_BUDGET_USD,
        timeoutMs: SPAWN_TIMEOUT_MS,
        maxRounds: SPAWN_MAX_ROUNDS,
      },
      { parentCtx },
    );
  }
}

// ── Module-level helpers (also exported for smoke / tests) ─────────────────

/**
 * Build the per-spawn user prompt. Sub-agents receive this verbatim;
 * combined with the role's system prompt it instructs the writer to
 * call `file_write` with the exact `latestPath` and produce the
 * 9-section markdown.
 */
export function buildSnapshotPrompt(args: {
  objective: string;
  recentMessages: ChatMessage[];
  historyTail: GoalHistoryEntry[];
  latestPath: string;
  cwd: string;
}): string {
  const { objective, recentMessages, historyTail, latestPath, cwd } = args;
  const tail = recentMessages.slice(-12); // bounded — avoid blowing the spawn

  const histLines = historyTail.length > 0
    ? historyTail.map(
        (h) =>
          `  - round ${h.round}${h.converged ? " ✓" : ""}: ${h.summary.slice(0, 120)}`,
      )
    : ["  (no goal history — ad-hoc session)"];

  const msgLines = tail.length > 0
    ? tail.map((m) => {
        const text = (m.content ?? "").slice(0, 240);
        return `  [${m.role}] ${text}`;
      })
    : ["  (no recent messages captured)"];

  return [
    `Write a checkpoint to ${latestPath}.`,
    "",
    `cwd: ${cwd}`,
    `objective: ${objective}`,
    "",
    "history (last 5 rounds):",
    ...histLines,
    "",
    "recent messages (truncated):",
    ...msgLines,
    "",
    "Use `file_write` with the EXACT path above. Output strictly the",
    "markdown template described in your system prompt — no extra prose,",
    "no code dump, ≤ 8 KB.",
  ].join("\n");
}

/**
 * Pick the agent's final markdown body out of its terminal handle. Today
 * we just take `result.content` — the assistant's last assistant message
 * text — and trust it; a stricter check would parse for the `# Checkpoint`
 * header. Returns `null` when the body is missing or empty.
 *
 * Why we don't parse the body for `<file_write>` calls: the agent runs
 * with `file_write` enabled and the tool itself writes the artifact; the
 * coordinator's write here is a *backup* path used when the agent failed
 * to call the tool, or to make the rule-based fallback symmetric.
 */
export function extractFinalMarkdown(handle: SubAgentHandle): string | null {
  if (!handle.result || !handle.result.ok) return null;
  const text = (handle.result.content ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Rule-based fallback. Used when the spawn fails / is cancelled / produces
 * an empty body. Spec line 122 ("失败时回退用 *规则化* 摘要") — we keep it
 * minimal so the user always has *something* on disk after a checkpoint
 * trigger. The body still respects the 9-section template so downstream
 * SCW parsing (step-27/28) doesn't have to special-case fallback files.
 */
export function buildFallbackMarkdown(
  input: CheckpointInput,
  ts: number,
  reason?: string,
): string {
  const iso = new Date(ts).toISOString();
  const histTail = (input.historyTail ?? []).slice(-3);
  const msgTail = (input.recentMessages ?? []).slice(-2);

  const lines: string[] = [];
  lines.push(`# Checkpoint ${iso}`);
  lines.push("");
  lines.push("## Goal");
  lines.push(input.objective ?? "ad-hoc");
  lines.push("");
  lines.push("## Done in this session");
  if (histTail.length > 0) {
    for (const h of histTail) {
      lines.push(`- round ${h.round}: ${h.summary.slice(0, 200)}`);
    }
  } else {
    lines.push("- (none recorded)");
  }
  lines.push("");
  lines.push("## In Progress");
  lines.push("- (fallback summary — agent unavailable)");
  lines.push("");
  lines.push("## Decisions");
  lines.push("- (none)");
  lines.push("");
  lines.push("## Files touched");
  lines.push("- (none recorded)");
  lines.push("");
  lines.push("## Open questions / Risks");
  if (reason) {
    lines.push(`- checkpoint-writer fallback engaged: ${reason}`);
  } else {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("## Next intended steps");
  if (msgTail.length > 0) {
    msgTail.forEach((m, i) => {
      const t = (m.content ?? "").slice(0, 200).replace(/\s+/g, " ");
      lines.push(`${i + 1}. [${m.role}] ${t}`);
    });
  } else {
    lines.push("1. (none — resume from /goal status)");
  }
  return lines.join("\n");
}

/**
 * Truncate `body` to ≤ `cap` bytes (UTF-8). Keeps a head + tail slice so
 * the section headers are visible. Inserts a `[truncated …]` marker.
 */
export function truncateBody(body: string, cap: number): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.byteLength <= cap) return body;
  const marker = "\n\n... [truncated by coordinator: body exceeded 8 KB] ...\n\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const room = cap - markerBytes;
  if (room <= 0) {
    // pathological cap — return marker only.
    return marker.slice(0, cap);
  }
  const half = Math.floor(room / 2);
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.byteLength - half).toString("utf8");
  return head + marker + tail;
}

/**
 * Rotate the timestamped archive directory: keep the newest `max`
 * `*.md` files (excluding `latest.md`); delete the rest.
 *
 * Sort key: `mtimeMs` from `safeFs.stat`. We don't use the filename
 * timestamp because the user (per spec §"用户可读") may hand-edit files,
 * which doesn't update the lexical name but does bump mtime.
 */
export async function rotateArchive(
  cwd: string,
  max = MAX_ARCHIVE_FILES,
): Promise<{ pruned: number }> {
  const dir = checkpointDir(cwd);
  const latest = latestCheckpointFile(cwd);
  let entries: string[];
  try {
    entries = await safeFs.list(dir, { recursive: false });
  } catch {
    return { pruned: 0 };
  }

  const archives: { path: string; mtime: number }[] = [];
  for (const entry of entries) {
    // `safeFs.list` returns names relative to dir on success.
    const full = entry.startsWith(dir) ? entry : `${dir}/${entry}`;
    if (!full.endsWith(".md")) continue;
    if (full === latest) continue;
    const st = await safeFs.stat(full);
    if (!st) continue;
    archives.push({ path: full, mtime: st.mtime });
  }

  if (archives.length <= max) return { pruned: 0 };
  archives.sort((a, b) => b.mtime - a.mtime); // newest first
  const toPrune = archives.slice(max);
  let pruned = 0;
  for (const a of toPrune) {
    try {
      await safeFs.remove(a.path);
      pruned += 1;
    } catch (err) {
      logger.debug("checkpoint: prune failed (continuing)", {
        path: a.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { pruned };
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _singleton: CheckpointCoordinator | null = null;

export function getCheckpointCoordinator(
  deps?: CheckpointCoordinatorDeps,
): CheckpointCoordinator {
  if (deps !== undefined) {
    // Caller-supplied deps build a fresh coordinator (tests / explicit
    // instantiation). We do NOT memoize this one — it's caller-owned.
    return new CheckpointCoordinator(deps);
  }
  if (_singleton === null) {
    _singleton = new CheckpointCoordinator();
  }
  return _singleton;
}

export function _resetCheckpointCoordinatorForTesting(): void {
  _singleton = null;
}
