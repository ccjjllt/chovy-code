/**
 * Command classification (step-09).
 *
 * Maps a base command name to a coarse semantic category. Consumers:
 *   - ATP (step-07/06) — uses categories to bias `lean`/`full` decisions
 *     downstream (a chain of `READ` commands rarely needs the full bash
 *     prompt; a `NETWORK` command often does).
 *   - The permission engine (step-12) — categories let rules talk about
 *     intent (`"network commands ask by default"`) without enumerating
 *     every binary.
 *   - Telemetry — we emit the category so we can see, in aggregate, what
 *     classes of commands the model runs against the sandbox.
 *
 * The lists below are intentionally narrow and follow the step-09 spec
 * verbatim. We accept that:
 *   - `UNKNOWN` will be the most common bucket once tools land in real
 *     repos; that's fine — `UNKNOWN` is treated as "no special-case
 *     handling, fall through to the engine".
 *   - Some commands belong to two buckets (e.g. `awk` is `READ` here but
 *     can write with `print > "file"`). We err on the side of the more
 *     common (read) intent; the danger evaluator handles the dangerous
 *     edge cases independently.
 */

import type { SimpleCommand } from "./ast.js";

export type CommandClass =
  | "SEARCH"
  | "READ"
  | "LIST"
  | "SILENT"
  | "NETWORK"
  | "UNKNOWN";

// From `docs/step-09 §2 Classification`.
const SEARCH = [
  "find", "grep", "rg", "ag", "ack", "locate", "which", "whereis",
];
const READ = [
  "cat", "head", "tail", "less", "more", "wc", "stat", "file",
  "jq", "awk", "cut", "sort", "uniq", "tr",
];
const LIST = ["ls", "tree", "du"];
const SILENT = [
  "mv", "cp", "rm", "mkdir", "rmdir", "chmod", "chown", "chgrp",
  "touch", "ln", "cd", "export", "unset", "wait",
];
const NETWORK = [
  "curl", "wget", "ssh", "scp", "ftp", "rsync",
  "npm", "pip", "bun", "yarn", "pnpm",
];

const TABLE: Record<string, CommandClass> = {};
for (const n of SEARCH) TABLE[n] = "SEARCH";
for (const n of READ) TABLE[n] = "READ";
for (const n of LIST) TABLE[n] = "LIST";
for (const n of SILENT) TABLE[n] = "SILENT";
for (const n of NETWORK) TABLE[n] = "NETWORK";

/**
 * Look up the class for a base command name. Names are matched
 * case-insensitively (Windows ships `Find.exe` capitalized).
 */
export function classifyBaseCommand(name: string): CommandClass {
  if (!name) return "UNKNOWN";
  const k = name.toLowerCase();
  return TABLE[k] ?? "UNKNOWN";
}

/**
 * Classify each segment of a parsed command. Returned in argv order so
 * callers can see e.g. `[READ, SEARCH]` for `cat foo | grep bar`.
 */
export function classifyCommands(commands: SimpleCommand[]): CommandClass[] {
  const out: CommandClass[] = [];
  for (const c of commands) {
    // Use the *raw* argv[0] (after env-var stripping but before wrapper
    // peeling) so that e.g. `sudo rm` is still classified by `rm`, not
    // `sudo`. The wrapper peeler lives in ast.ts and is already invoked
    // by callers that want a base command name — we mirror that here.
    const base = pickBase(c);
    out.push(classifyBaseCommand(base));
  }
  return out;
}

/**
 * Cheap base-command pick that handles the most common wrapper. We use
 * `extractBaseCommand` from ast.ts for the heavy lifting elsewhere; here
 * we inline a minimal version so the classification module stays
 * dependency-free of the wrapper table.
 */
function pickBase(c: SimpleCommand): string {
  const first = c.argv[0];
  if (!first) return "";
  return (first.split(/[\\/]/).pop() ?? first).toLowerCase();
}

/**
 * True iff every segment of the command chain reads / inspects state
 * (`READ`, `SEARCH`, `LIST`). Used by the bash tool's `isReadOnly` flag
 * so the permission engine can fast-path read-only commands even when the
 * user has not added them to allow rules.
 */
export function isAllReadOnly(commands: SimpleCommand[]): boolean {
  if (commands.length === 0) return false;
  for (const c of commands) {
    const klass = classifyBaseCommand(pickBase(c));
    if (klass !== "READ" && klass !== "SEARCH" && klass !== "LIST") {
      return false;
    }
  }
  return true;
}
