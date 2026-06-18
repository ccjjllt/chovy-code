/**
 * Sub-agent lifecycle helpers (step-18).
 *
 * The runtime keeps `SubAgentHandle` mutable but routes ALL state changes
 * through `setStatus()` so we have a single chokepoint for:
 *   - validating legal transitions (per `architecture.md §4.1`),
 *   - stamping `finishedAt` on terminal transitions,
 *   - keeping `phase` honest (terminal states normalize the phase label).
 *
 * The pool (`pool.ts`) owns telemetry emission; this module is pure data
 * + transition logic with no side effects beyond mutating the handle and
 * resolving the cancel-promise. Keeping it side-effect-free lets tests
 * exercise the state machine without touching the telemetry sink.
 */
import { ChovyError } from "../types/errors.js";
import { emitSwarmEvent } from "./swarmBus.js";
import type {
  AgentLifecycle,
  AgentRole,
  ProviderId,
  SubAgentHandle,
  SubAgentResult,
} from "../types/index.js";

const TERMINAL: ReadonlySet<AgentLifecycle> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/**
 * Legal transitions per `docs/step-18 §状态转移`. `paused` exits back to
 * `running` (goal-loop resume in step-23) and may also be terminated
 * directly if cancelled while paused.
 */
const LEGAL: Readonly<Record<AgentLifecycle, ReadonlySet<AgentLifecycle>>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["done", "failed", "cancelled", "paused"]),
  paused: new Set(["running", "cancelled", "failed"]),
  // terminal:
  done: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/** Internal mutable view used by the pool. The public `SubAgentHandle`
 *  shape is unchanged; we just mark some fields as no-longer-readonly so
 *  the pool can mutate them without `as` casts. */
export interface MutableSubAgentHandle extends SubAgentHandle {
  // (every field on SubAgentHandle is already non-readonly today; this
  // alias exists purely for documentation — the pool deliberately treats
  // its handles as opaque outside this module.)
}

export interface MakeHandleOptions {
  id: string;
  parentId: string;
  role: AgentRole;
  prompt: string;
  background: boolean;
  provider?: ProviderId;
  model?: string;
  /** Hook invoked when `cancel()` is called. The pool wires this to the
   *  child's AbortController. Idempotent; re-cancellations are no-ops. */
  onCancel: () => void | Promise<void>;
}

export function makeHandle(opts: MakeHandleOptions): MutableSubAgentHandle {
  let cancelled = false;
  const handle: MutableSubAgentHandle = {
    id: opts.id,
    parentId: opts.parentId,
    role: opts.role,
    prompt: opts.prompt,
    status: "queued",
    phase: "queued",
    spawnedAt: Date.now(),
    costUSD: 0,
    tokensIn: 0,
    tokensOut: 0,
    provider: opts.provider,
    model: opts.model,
    background: opts.background,
    cancel: async () => {
      // Cancel is idempotent: terminal-state handles resolve immediately,
      // and double-cancel must NOT re-fire onCancel.
      if (cancelled) return;
      cancelled = true;
      if (TERMINAL.has(handle.status)) return;
      await opts.onCancel();
    },
  };
  return handle;
}

/**
 * Apply a transition to `handle.status`. Throws `ChovyError("INTERNAL")`
 * on illegal transitions — those indicate a runtime bug, not a model
 * error. Callers MUST call this rather than mutating `status` directly.
 *
 * Side-effects (intentional, all on the handle itself):
 *   - terminal transitions stamp `finishedAt`,
 *   - terminal transitions normalize `phase` to the new status name,
 *   - `running` transitions clear stale `result` from a re-spawned handle.
 */
export function setStatus(
  handle: MutableSubAgentHandle,
  next: AgentLifecycle,
): void {
  const cur = handle.status;
  if (cur === next) return; // idempotent re-assertion
  const allowed = LEGAL[cur];
  if (!allowed.has(next)) {
    throw new ChovyError(
      "INTERNAL",
      `illegal sub-agent transition ${cur} → ${next} (id=${handle.id})`,
      undefined,
      { id: handle.id, from: cur, to: next },
    );
  }
  handle.status = next;
  if (next === "running") {
    handle.phase = "running";
    handle.result = undefined;
  } else if (TERMINAL.has(next)) {
    handle.finishedAt = Date.now();
    handle.phase = next;
  } else if (next === "paused") {
    handle.phase = "paused";
  }
  // step-22: broadcast lifecycle transitions so the Ink SwarmPanel updates
  // without polling. This is the single chokepoint for status mutation, so
  // emitting here guarantees the UI sees every legal transition.
  emitSwarmEvent({ type: "lifecycle", id: handle.id, status: next });
}

/** True iff the handle has reached a terminal state. */
export function isTerminal(handle: SubAgentHandle): boolean {
  return TERMINAL.has(handle.status);
}

/** Stamp the final result and move the handle to a terminal state. The
 *  pool calls this once it has the QueryEngine result in hand. */
export function finalize(
  handle: MutableSubAgentHandle,
  result: SubAgentResult,
  status: Extract<AgentLifecycle, "done" | "failed" | "cancelled">,
): void {
  handle.result = result;
  handle.costUSD = result.costUSD;
  setStatus(handle, status);
}

/** Free-form phase update (the model / runtime can broadcast progress). */
export function setPhase(
  handle: MutableSubAgentHandle,
  phase: string,
): void {
  if (TERMINAL.has(handle.status)) return; // never overwrite terminal phase
  handle.phase = phase;
  // step-22: phase changes (e.g. "reading file foo.ts") drive the live row
  // in the SwarmPanel. Emit progress so the throttled store re-renders.
  emitSwarmEvent({ type: "progress", id: handle.id, phase });
}

/** Roll up token usage from a single QueryEngine round into the handle. */
export function addUsage(
  handle: MutableSubAgentHandle,
  usage: { in: number; out: number; cacheRead?: number },
): void {
  handle.tokensIn += usage.in;
  handle.tokensOut += usage.out;
  // step-22: live cost rollup. The handle's costUSD is updated by the pool
  // from the QueryEngine result; tokens update here. Emit cost so the
  // SwarmPanel budget line refreshes.
  emitSwarmEvent({ type: "cost", id: handle.id });
}

/** Compact base36 id (default 8 chars) prefixed `sa_`. Falls back to a
 *  longer suffix if `crypto.randomUUID` isn't available. */
export function makeSubAgentId(): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(6);
    g.crypto.getRandomValues(bytes);
    let n = 0;
    for (const b of bytes) n = n * 256 + b;
    return `sa_${n.toString(36).slice(0, 8).padStart(8, "0")}`;
  }
  return `sa_${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
}
