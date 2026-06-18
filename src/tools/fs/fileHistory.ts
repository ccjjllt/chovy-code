/**
 * File history & read-set tracker (step-08).
 *
 * Two pieces of in-memory bookkeeping that the fs tools share:
 *
 *   1. **Read set** — the set of absolute paths that have been opened by
 *      `file_read` in the current process. `file_edit` requires the file to
 *      have been read first (the "blind-write guard" lifted from cc-haha's
 *      FileEditTool); without a prior `file_read`, the model is editing a
 *      file it has not seen, which historically produces wrong patches.
 *
 *   2. **Change log** — a per-file record of (size before, size after, +/−
 *      lines, mtime). The cost-tracker (step-16) and the UI's status line
 *      (step-22) both want this so we can show "edited 3 files (+12 −4)"
 *      and bill diffs against the budget.
 *
 * Scope is *intentionally* a module-level singleton: there is no
 * `ctx.session` field in the step-06 `ToolContext` yet, and the agent loop
 * doesn't pass `ctx` into `tool.run` today (see `src/agent/agent.ts`).
 * Once step-16's QueryEngine / step-18's session-scoped state lands, this
 * module's exports become a back-compat facade over `ctx.session.fileHistory`.
 *
 * TODO step-16: move the underlying state onto `ToolContext.session` so each
 *   sub-agent / fork gets its own read set instead of sharing the process
 *   one. The public function shapes here are designed to survive that move.
 */

import { resolve } from "node:path";

/** Per-file entry tracked across reads / writes / edits. */
export interface FileHistoryEntry {
  /** Absolute, resolved path (case-preserving on POSIX, casefolded on Win is NOT done — keep raw). */
  path: string;
  /** Last time the file was read by `file_read`, or 0 if never. */
  lastReadAt: number;
  /** Bytes returned on the most recent read (after offset/limit truncation). */
  lastReadBytes: number;
  /** Number of times `file_write` / `file_edit` mutated this file. */
  writes: number;
  /** Cumulative net lines added (positive) / removed (negative) across writes. */
  linesDelta: number;
}

const entries = new Map<string, FileHistoryEntry>();

/** Normalize once so callers don't have to think about `..` / case. */
function key(p: string): string {
  return resolve(p);
}

function ensure(path: string): FileHistoryEntry {
  const k = key(path);
  let e = entries.get(k);
  if (!e) {
    e = {
      path: k,
      lastReadAt: 0,
      lastReadBytes: 0,
      writes: 0,
      linesDelta: 0,
    };
    entries.set(k, e);
  }
  return e;
}

/** Record that `path` was read just now. Called by `file_read`. */
export function markRead(path: string, bytes: number): void {
  const e = ensure(path);
  e.lastReadAt = Date.now();
  e.lastReadBytes = bytes;
}

/** True when the file has been read at least once in this process. */
export function wasRead(path: string): boolean {
  return (entries.get(key(path))?.lastReadAt ?? 0) > 0;
}

/** Record a mutation (write / edit). `linesDelta` may be negative. */
export function recordChange(path: string, linesDelta: number): void {
  const e = ensure(path);
  e.writes += 1;
  e.linesDelta += linesDelta;
  // A successful write also "freshens" the read state — the tool that
  // mutated the file just observed it. This avoids the awkward case where
  // a write is followed by an edit and the edit guard rejects it.
  e.lastReadAt = Date.now();
}

/** Snapshot of the entry for diagnostics / tests. */
export function getHistory(path: string): FileHistoryEntry | undefined {
  const e = entries.get(key(path));
  return e ? { ...e } : undefined;
}

/** Test-only: forget every tracked file. */
export function _resetFileHistoryForTesting(): void {
  entries.clear();
}

/**
 * Cheap line-delta heuristic — counts `\n` in `before` and `after` and
 * returns `after − before`. CRLF and LF both end with `\n` so this is
 * platform-neutral.
 */
export function lineDelta(before: string, after: string): number {
  return countLines(after) - countLines(before);
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) n++;
  }
  // A trailing-newline-less file still has 1 logical line.
  if (s.charCodeAt(s.length - 1) !== 0x0a) n += 1;
  return n;
}
