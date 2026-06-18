/**
 * `EndTruncatingAccumulator` (step-09).
 *
 * Bounded ring buffer for command output. Keeps the first N bytes (the
 * "head") and the most recent M bytes (the "tail"). When more data
 * arrives than the cap permits, the middle is dropped and a marker
 * `… [truncated K bytes] …` is rendered between head and tail at
 * stringification time. The model gets enough context from both ends to
 * see what the command started doing and what it ended up doing — the
 * uninteresting middle of a long log is the easiest thing to give up.
 *
 * Why two windows instead of one tail-only cap?
 *   - Compile / lint output: the first frames are usually banner +
 *     warnings setup; the model needs them to recognize the build system.
 *   - Test runners: the head shows what suite started; the tail shows the
 *     failures. The middle (per-test pass dots) is noise.
 *   - cc-haha uses the same pattern (`EndTruncatingAccumulator`); we
 *     adopt the shape, not the implementation — theirs is a streaming
 *     two-buffer ring; ours is a simpler append-then-render because we
 *     only buffer in-process and the cap fits in memory.
 *
 * Limits (per stream, configurable on construction):
 *   - `headBytes` — default 8 KiB. First slice held verbatim.
 *   - `tailBytes` — default 22 KiB. Rolling slice from the end.
 *   - Total cap = 30 KiB to match `docs/step-09 §5`.
 */

const DEFAULT_HEAD = 8 * 1024; // 8 KiB
const DEFAULT_TAIL = 22 * 1024; // 22 KiB
// Default total = 30 KiB ≈ step-09 spec.

export interface AccumulatorOptions {
  headBytes?: number;
  tailBytes?: number;
}

export class EndTruncatingAccumulator {
  private head = "";
  private tail = "";
  private dropped = 0;
  private readonly headCap: number;
  private readonly tailCap: number;
  private totalBytes = 0;

  constructor(opts: AccumulatorOptions = {}) {
    this.headCap = opts.headBytes ?? DEFAULT_HEAD;
    this.tailCap = opts.tailBytes ?? DEFAULT_TAIL;
  }

  /** Append a chunk. The chunk may be larger than either cap. */
  append(chunk: string): void {
    if (chunk === "") return;
    this.totalBytes += chunk.length;

    // 1. Fill head first (verbatim) until headCap reached.
    if (this.head.length < this.headCap) {
      const room = this.headCap - this.head.length;
      if (chunk.length <= room) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      // fall through to push the remainder into the tail
    }

    // 2. Push remainder onto the tail rolling window.
    if (chunk.length >= this.tailCap) {
      // The new chunk alone overflows the tail — drop everything that was
      // there, then keep only the trailing window of `chunk`.
      this.dropped += this.tail.length + (chunk.length - this.tailCap);
      this.tail = chunk.slice(chunk.length - this.tailCap);
      return;
    }
    // Tail has room or partial; append, then trim from the front if over.
    const combined = this.tail + chunk;
    if (combined.length <= this.tailCap) {
      this.tail = combined;
      return;
    }
    const overflow = combined.length - this.tailCap;
    this.dropped += overflow;
    this.tail = combined.slice(overflow);
  }

  /** Total bytes ever appended (across head + tail + dropped). */
  get total(): number {
    return this.totalBytes;
  }

  /** Bytes that fell out of the middle (head full → tail rolled). */
  get droppedBytes(): number {
    return this.dropped;
  }

  /** True iff anything was dropped. */
  get isTruncated(): boolean {
    return this.dropped > 0;
  }

  /**
   * Render head + truncation marker + tail. When nothing was dropped this
   * is just `head + tail`. The marker is intentionally distinctive so the
   * model can detect truncation and re-run with a narrower filter if
   * needed — cc-haha uses the same `[N lines truncated]` phrasing.
   */
  toString(): string {
    if (!this.isTruncated) return this.head + this.tail;
    return (
      this.head +
      `\n... [truncated ${this.dropped} bytes] ...\n` +
      this.tail
    );
  }
}
