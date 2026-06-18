/**
 * Per-sub-agent streamed-output ring buffer (step-22).
 *
 * The pool's child `QueryEngine` `onToken` hook feeds each text delta here,
 * keyed by sub-agent id. The Ink `AgentDetail` overlay reads it back to
 * render the "Last output (preview)" row from `docs/step-22-agent-ui.md
 * §详情浮层`.
 *
 * Why a separate module (not a `SubAgentHandle` field):
 *   - `SubAgentHandle` is frozen at step-18; adding a streaming-token field
 *     would widen every handle and leak UI concerns into the runtime type.
 *   - The buffer is *display-only* — it never feeds the model or telemetry —
 *     so isolating it keeps the runtime type honest.
 *
 * Lifecycle: buffers persist past a handle's terminal transition so the user
 * can open `AgentDetail` on a just-finished agent. They're cleared on
 * `pool.reset()` and evicted by a 60s TTL sweeper (`evictExpired`) that the
 * pool can call opportunistically. The ring keeps the **last** 2KB so a long
 * run doesn't grow unbounded while still showing the most recent output.
 */

const MAX_BYTES = 2 * 1024; // 2KB ring per agent

const buffers = new Map<string, string>();
/** `finishedAt` stamp per id, so the TTL sweeper can evict cold entries. */
const finishedAt = new Map<string, number>();

/** Append a streamed delta to the agent's ring buffer. Caps at MAX_BYTES
 *  (keeping the tail) so memory stays bounded across long runs. */
export function appendOutput(id: string, delta: string): void {
  if (!delta) return;
  const cur = buffers.get(id) ?? "";
  let next = cur + delta;
  if (next.length > MAX_BYTES) {
    // Keep the last MAX_BYTES chars (the "live" tail the preview shows).
    next = next.slice(next.length - MAX_BYTES);
  }
  buffers.set(id, next);
}

/** Read the buffered output for an agent (empty string if none / cleared). */
export function getOutput(id: string): string {
  return buffers.get(id) ?? "";
}

/** Mark an agent's buffer as terminal (for TTL eviction). Called by the
 *  pool when a handle finalizes; the buffer itself is retained so the UI
 *  can still read it. */
export function markFinished(id: string, at: number = Date.now()): void {
  finishedAt.set(id, at);
}

/** Explicitly drop an agent's buffer (e.g. on `pool.reset()`). */
export function clearOutput(id: string): void {
  buffers.delete(id);
  finishedAt.delete(id);
}

/** Evict buffers whose handle has been terminal for more than `ttlMs`
 *  (default 60s). Returns the count evicted. The pool calls this
 *  opportunistically; it's cheap (O(n) over the small finished set). */
export function evictExpired(ttlMs = 60_000, now: number = Date.now()): number {
  let n = 0;
  for (const [id, at] of finishedAt) {
    if (now - at >= ttlMs) {
      buffers.delete(id);
      finishedAt.delete(id);
      n++;
    }
  }
  return n;
}

/** Current buffered-id count (test-only). */
export function _outputBufferCount(): number {
  return buffers.size;
}

/** Test-only: drop every buffer. Production code MUST NOT call this. */
export function _resetOutputBuffersForTesting(): void {
  buffers.clear();
  finishedAt.clear();
}
