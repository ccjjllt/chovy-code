/** A tiny leveled logger. Ink components render their own UI; this is for the
 *  non-interactive paths (build, one-shot commands, --verbose tracing). */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

class Logger {
  level: Level = "info";

  setLevel(level: Level): void {
    this.level = level;
  }

  private emit(level: Level, msg: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `${COLORS[level]}${level.padEnd(5)}${RESET} ${stamp} ${msg}`;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(line + "\n");
    if (meta !== undefined) stream.write(`        ${JSON.stringify(meta)}\n`);
  }

  debug(msg: string, meta?: unknown): void { this.emit("debug", msg, meta); }
  info(msg: string, meta?: unknown): void { this.emit("info", msg, meta); }
  warn(msg: string, meta?: unknown): void { this.emit("warn", msg, meta); }
  error(msg: string, meta?: unknown): void { this.emit("error", msg, meta); }
}

/** Shared singleton. */
export const logger = new Logger();
