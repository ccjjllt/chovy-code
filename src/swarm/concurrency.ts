/**
 * Concurrency limiter (step-20 SwarmR).
 *
 * Minimal p-limit-style limiter: bound the number of in-flight async tasks
 * without pulling a dependency. The router wraps each sub-agent `spawn` in
 * `limiter.run(() => ...)` so `parallelism` is enforced even though the
 * underlying `SubAgentPool.spawn` is happy to accept 100 concurrent calls.
 *
 * Design:
 *   - FIFO queue of pending runnables; each released slot is filled by the
 *     oldest waiter (no starvation / no priority).
 *   - `active` is exposed so the router can assert the invariant
 *     "≤ parallelism in flight" in the smoke harness.
 *   - The limiter is *not* the sub-agent pool — it only throttles how many
 *     spawns the router kicks off in parallel. The pool still enforces its
 *     own 100-handle hard cap (AGENTS.md §16 / step-18).
 *
 * Intentionally no `clear()`: a cancelled dispatch cancels the *runnables*
 * via their own abort signals, not by draining the queue — draining would
 * drop work that the caller expects to observe as `cancelled` results.
 */
export interface ConcurrencyLimiter {
  /** Current number of runnables executing. */
  readonly active: number;
  /** Number of runnables waiting for a slot. */
  readonly pending: number;
  /** Concurrency cap (immutable after construction). */
  readonly concurrency: number;
  /** Run `fn`, awaiting a free slot first. Resolves/ rejects with `fn`'s result. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLimiter(concurrency: number): ConcurrencyLimiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`createLimiter: concurrency must be a positive int (got ${concurrency})`);
  }
  let active = 0;
  // Queue of (resume, reject) pairs — one per waiter. We resolve the saved
  // promise when a slot opens; rejecting propagates a limiter-level fault
  // (today only `concurrency < 1` at construction, which throws above, so
  // the reject arm is defensive only).
  const waiters: Array<{
    run: () => void;
    reject: (err: unknown) => void;
  }> = [];

  // Wake the oldest waiter (if any) *without* claiming a slot for it: the
  // waiter's own `run` body does the `active++` claim. We deliberately do
  // NOT increment here — doing so would double-count (the waiter also
  // increments) and let `active` exceed `concurrency`. This is the bug the
  // step-20 smoke caught at parallelism=2 / >4 prompts.
  const wake = (): void => {
    const w = waiters.shift();
    if (w) w.run();
  };

  return {
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
    get concurrency() {
      return concurrency;
    },

    async run<T>(fn: () => Promise<T>): Promise<T> {
      // Claim a slot. The fast path takes one immediately; otherwise we
      // queue and are woken by `wake()` (called from a finishing task's
      // finally block). After being woken we *re-check* the cap before
      // claiming — a wake is advisory, not a guaranteed slot, so two
      // waiters racing on a single freed slot don't both claim it.
      if (active < concurrency) {
        active++;
      } else {
        await new Promise<void>((resolve, reject) => {
          waiters.push({ run: resolve, reject });
        });
        // Re-check: another fast-path caller may have grabbed the slot
        // between our wake and here. If so, re-queue. (Rare; bounded by the
        // number of concurrent finishers.)
        while (active >= concurrency) {
          await new Promise<void>((resolve, reject) => {
            waiters.push({ run: resolve, reject });
          });
        }
        active++;
      }
      try {
        return await fn();
      } finally {
        active--;
        // Freed a slot → wake one waiter so it can re-check + claim.
        wake();
      }
    },
  };
}
