/**
 * Structured logger.
 *
 * Step-03: replaces the original tiny leveled logger with:
 *   - 6 levels: trace / debug / info / warn / error / silent
 *   - child(scope) → adds a `scope` field to every record
 *   - human-readable on TTY, NDJSON when CHOVY_LOG_JSON=1 or stdout isn't a TTY
 *   - error(err) accepts an Error and pulls name/message/stack
 *
 * Telemetry sink (one-line-per-event in `~/.chovy/telemetry/<date>.jsonl`)
 * lives in `src/telemetry/`; this module only handles human/CI text output.
 */

import {
  LEVEL_ORDER,
  formatHuman,
  formatJson,
  type Level,
  type LogRecord,
} from "./format.js";
import { formatChovyError, isChovyError } from "../types/errors.js";

export type { Level } from "./format.js";

export interface Logger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msgOrErr: string | Error, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
  setLevel(level: Level): void;
  getLevel(): Level;
}

interface CoreState {
  level: Level;
  json: boolean;
  color: boolean;
}

/** A single shared state object so child loggers see live setLevel changes. */
const core: CoreState = {
  level: parseLevel(process.env.CHOVY_LOG_LEVEL) ?? "info",
  json: process.env.CHOVY_LOG_JSON === "1" || !process.stdout.isTTY,
  color: !!process.stdout.isTTY && process.env.NO_COLOR !== "1",
};

function parseLevel(raw: string | undefined): Level | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v in LEVEL_ORDER) return v as Level;
  return undefined;
}

function emit(level: Exclude<Level, "silent">, scope: string | undefined,
              msgOrErr: string | Error, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[core.level]) return;

  const chovyErr = isChovyError(msgOrErr) ? msgOrErr : undefined;
  const record: LogRecord = {
    level,
    msg: chovyErr
      ? formatChovyError(chovyErr)
      : typeof msgOrErr === "string" ? msgOrErr : msgOrErr.message,
    ts: Date.now(),
    ...(scope ? { scope } : {}),
    ...(chovyErr || meta ? {
      meta: {
        ...(chovyErr ? { code: chovyErr.code, ...(chovyErr.meta ?? {}) } : {}),
        ...(meta ?? {}),
      },
    } : {}),
  };
  if (msgOrErr instanceof Error && !chovyErr) {
    record.err = {
      name: msgOrErr.name,
      message: msgOrErr.message,
      ...(msgOrErr.stack ? { stack: msgOrErr.stack } : {}),
    };
  }

  const line = core.json ? formatJson(record) : formatHuman(record, core.color);
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

function makeLogger(scope?: string): Logger {
  return {
    trace(msg, meta) { emit("trace", scope, msg, meta); },
    debug(msg, meta) { emit("debug", scope, msg, meta); },
    info(msg, meta) { emit("info", scope, msg, meta); },
    warn(msg, meta) { emit("warn", scope, msg, meta); },
    error(msgOrErr, meta) { emit("error", scope, msgOrErr, meta); },
    child(child) {
      const next = scope ? `${scope}.${child}` : child;
      return makeLogger(next);
    },
    setLevel(level) { core.level = level; },
    getLevel() { return core.level; },
  };
}

/** Switch JSON output on/off at runtime (mostly for tests). */
export function setJsonOutput(on: boolean): void { core.json = on; }

/** Inspect current effective level — useful for `--verbose` echoes. */
export function currentLevel(): Level { return core.level; }

/** Shared root logger. */
export const logger: Logger = makeLogger();
