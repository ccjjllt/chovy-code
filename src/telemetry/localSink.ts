/**
 * Local-only telemetry sink: writes JSONL to ~/.chovy/telemetry/<date>.jsonl.
 *
 * Step-03 commits to *no remote upload* — this is the only place events
 * land, and they stay on disk. Writes are buffered (default 100 ms flush)
 * to keep high-frequency events cheap; the sink also flushes on `beforeExit`
 * and exposes an explicit `flush()` for short-lived CLI runs.
 *
 * NOTE: filesystem access here is intentionally synchronous (mkdirSync /
 *   appendFileSync). The flush path runs from a setInterval callback and
 *   from `beforeExit` / `exit` hooks, where awaiting promises is unsafe —
 *   the process can terminate before microtasks drain. `safeFs` is async
 *   by design and is therefore NOT used here. Step-04 only swaps the
 *   home-dir resolver for the canonical one in `src/fs/home.ts`.
 */

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chovyTelemetryDir } from "../fs/home.js";
import { logger } from "../logger/index.js";
import type { TelemetryEvent, TelemetryEventInput } from "./events.js";

export interface TelemetrySinkOptions {
  /** Override the directory (defaults to ~/.chovy/telemetry). Tests use this. */
  dir?: string;
  /** Buffered flush interval in ms. 0 disables buffering. Default 100. */
  flushMs?: number;
  /** Disable disk writes entirely (e.g. CHOVY_TELEMETRY=0). */
  enabled?: boolean;
}

export interface TelemetrySink {
  emit(event: TelemetryEventInput): void;
  flush(): Promise<void>;
  /** Stop the periodic timer; remaining events are flushed synchronously. */
  close(): void;
  /** Path of the file we'd write to *right now* (depends on local date). */
  currentFile(): string;
  readonly enabled: boolean;
}

/** YYYY-MM-DD in *local* time so filenames line up with what humans expect. */
function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

class FileTelemetrySink implements TelemetrySink {
  readonly enabled: boolean;

  private readonly dir: string;
  private readonly flushMs: number;
  private queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private exitHookInstalled = false;

  constructor(opts: TelemetrySinkOptions) {
    this.dir = opts.dir ?? chovyTelemetryDir();
    this.flushMs = opts.flushMs ?? 100;
    this.enabled = opts.enabled ?? true;
    if (this.enabled && this.flushMs > 0) {
      this.timer = setInterval(() => this.flushSync(), this.flushMs);
      // .unref() so a one-shot CLI doesn't linger waiting on this timer.
      this.timer.unref?.();
    }
    if (this.enabled) this.installExitHook();
  }

  emit(input: TelemetryEventInput): void {
    if (!this.enabled) return;
    const event = { ...input, ts: Date.now() } as TelemetryEvent;
    this.queue.push(event);
    if (this.flushMs === 0) this.flushSync();
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }

  currentFile(): string {
    return join(this.dir, `${localDate()}.jsonl`);
  }

  private flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      // Write per-day file so date-rollover splits cleanly even mid-flush.
      const grouped = new Map<string, string[]>();
      for (const ev of batch) {
        const file = join(this.dir, `${localDate(new Date(ev.ts))}.jsonl`);
        const line = JSON.stringify(ev);
        const arr = grouped.get(file) ?? [];
        arr.push(line);
        grouped.set(file, arr);
      }
      for (const [file, lines] of grouped) {
        appendFileSync(file, lines.join("\n") + "\n", "utf8");
      }
    } catch (err) {
      // Telemetry failures must never crash the agent; log once at debug
      // so test runs don't drown in noise.
      logger.debug("telemetry flush failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-queue events so a later flush can retry, but cap to avoid runaway.
      if (this.queue.length < 1000) this.queue.unshift(...batch);
    }
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    const flush = (): void => this.flushSync();
    process.on("beforeExit", flush);
    process.on("exit", flush);
  }
}

class NullSink implements TelemetrySink {
  readonly enabled = false;
  emit(): void { /* no-op */ }
  async flush(): Promise<void> { /* no-op */ }
  close(): void { /* no-op */ }
  currentFile(): string { return ""; }
}

let shared: TelemetrySink | null = null;

/** Get (or lazily create) the process-wide sink. Honors CHOVY_TELEMETRY=0. */
export function getTelemetrySink(): TelemetrySink {
  if (shared) return shared;
  const disabled = process.env.CHOVY_TELEMETRY === "0";
  shared = disabled ? new NullSink() : new FileTelemetrySink({});
  return shared;
}

/** Tests use this to override the global sink with a tmp-dir one. */
export function setTelemetrySink(sink: TelemetrySink): void {
  shared = sink;
}

/** Factory; tests use this directly with a tmp dir. */
export function createTelemetrySink(opts: TelemetrySinkOptions = {}): TelemetrySink {
  return opts.enabled === false ? new NullSink() : new FileTelemetrySink(opts);
}

/** Convenience emitter using the shared sink. */
export function emitTelemetry(event: TelemetryEventInput): void {
  getTelemetrySink().emit(event);
}
