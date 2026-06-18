/**
 * Logger formatters — human-readable (ANSI) and NDJSON.
 *
 * Step-03 of the chovy-code plan keeps these in their own file so the logger
 * core stays small and we can swap formats without touching emission logic.
 */

export type Level = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export const LEVEL_ORDER: Record<Level, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const COLORS: Record<Exclude<Level, "silent">, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export interface LogRecord {
  level: Exclude<Level, "silent">;
  msg: string;
  scope?: string;
  meta?: Record<string, unknown>;
  /** Epoch ms; the logger fills this in. */
  ts: number;
  /** Optional Error that was passed to logger.error(err). */
  err?: { name: string; message: string; stack?: string };
}

/** ISO-8601 in UTC, kept short for dense terminals. */
function shortTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

/** Pretty / colorized line — used when stdout is a TTY and JSON mode is off. */
export function formatHuman(record: LogRecord, useColor: boolean): string {
  const tag = record.level.padEnd(5);
  const color = useColor ? COLORS[record.level] : "";
  const reset = useColor ? RESET : "";
  const scope = record.scope ? ` [${record.scope}]` : "";
  const head = `${color}${tag}${reset} ${shortTime(record.ts)}${scope} ${record.msg}`;

  // Render meta / errors as an indented follow-on line so the head stays scannable.
  const tail: string[] = [];
  if (record.meta && Object.keys(record.meta).length > 0) {
    tail.push(`        ${safeStringify(record.meta)}`);
  }
  if (record.err?.stack) {
    tail.push(record.err.stack.replace(/^/gm, "        "));
  }
  return tail.length === 0 ? head : `${head}\n${tail.join("\n")}`;
}

/** NDJSON — one JSON object per line, machine-friendly. */
export function formatJson(record: LogRecord): string {
  return safeStringify({
    t: record.ts,
    level: record.level,
    scope: record.scope,
    msg: record.msg,
    ...(record.meta ?? {}),
    ...(record.err ? { err: record.err } : {}),
  });
}

/** JSON.stringify that never throws (handles cycles + BigInt). */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}
