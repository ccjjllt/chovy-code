/**
 * `safeFs` — the only module in chovy-code that touches `node:fs` directly
 * for *application* I/O. All higher-level modules (memory, checkpoint,
 * tools/fs/*, skills, …) MUST import from here.
 *
 * Guarantees:
 *   - Every error is wrapped in `ChovyError('MEMORY_IO', …)` so callers
 *     can branch on `code` instead of `errno`.
 *   - `write()` is atomic: it writes to a sibling `.tmp` file then renames.
 *   - `remove()` refuses any path outside `chovyHome()` — a hard guardrail
 *     against runaway tools / agents that try to `rm -rf /`.
 *
 * Out of scope (deliberate):
 *   - Locking / multi-process coordination (atomic rename is sufficient
 *     for our single-CLI-per-cwd invariant; cross-process races are logged
 *     as telemetry events instead).
 *   - Streaming reads/writes (memory store will use `bun:sqlite` for that).
 */

import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

import { ChovyError } from "../types/errors.js";
import { chovyHome } from "./home.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Wrap any low-level error in a ChovyError(MEMORY_IO). Returns `never`. */
function fail(op: string, path: string, err: unknown): never {
  if (err instanceof ChovyError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  throw new ChovyError(
    "MEMORY_IO",
    `safeFs.${op} failed for ${path}: ${message}`,
    err,
    { op, path, ...(code ? { errno: code } : {}) },
  );
}

/** True iff `child` is `parent` itself or a descendant of it. */
export function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  return c.startsWith(p + sep);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function read(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    return fail("read", p, err);
  }
}

function readSync(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch (err) {
    return fail("readSync", p, err);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return fail("exists", p, err);
  }
}

async function mkdirp(p: string): Promise<void> {
  try {
    await mkdir(p, { recursive: true });
  } catch (err) {
    fail("mkdirp", p, err);
  }
}

/**
 * Atomic write: stage to `<p>.<pid>.<rand>.tmp` in the same directory, then
 * rename onto the target. Same-directory rename is atomic on every supported
 * platform (POSIX rename(2), Windows MoveFileEx).
 *
 * Creates `dirname(p)` if missing — callers shouldn't have to mkdirp first.
 */
async function write(p: string, content: string): Promise<void> {
  const dir = dirname(p);
  const tmp = join(dir, `.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, content, { encoding: "utf8" });
    await rename(tmp, p);
  } catch (err) {
    // Best-effort cleanup of the temp file — ignore failure (it may not
    // exist yet, or the rename already consumed it).
    try {
      await rm(tmp, { force: true });
    } catch {
      /* ignore */
    }
    fail("write", p, err);
  }
}

async function append(p: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, content, { encoding: "utf8" });
  } catch (err) {
    fail("append", p, err);
  }
}

async function list(
  p: string,
  opts: { recursive?: boolean } = {},
): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    const out: string[] = [];
    for (const ent of entries) {
      const full = join(p, ent.name);
      if (ent.isDirectory()) {
        if (opts.recursive) {
          const sub = await list(full, opts);
          out.push(...sub);
        }
        // Non-recursive listings deliberately omit subdirs — callers that
        // need both files and dirs should use `node:fs` directly.
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        out.push(full);
      }
    }
    return out;
  } catch (err) {
    return fail("list", p, err);
  }
}

async function statOne(
  p: string,
): Promise<{ size: number; mtime: number } | null> {
  try {
    const s = await stat(p);
    return { size: s.size, mtime: s.mtimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return fail("stat", p, err);
  }
}

/**
 * Recursive remove with a hard guardrail: only paths inside `chovyHome()`
 * are allowed. The chovy home root itself is also forbidden — callers that
 * really need to wipe the home should do it manually (and answer to the
 * user first).
 */
async function remove(p: string): Promise<void> {
  const home = chovyHome();
  if (!isWithin(home, p)) {
    throw new ChovyError(
      "MEMORY_IO",
      `safeFs.remove refused: ${p} is outside chovy home (${home})`,
      undefined,
      { op: "remove", path: p, allowedRoot: home },
    );
  }
  if (resolve(p) === resolve(home)) {
    throw new ChovyError(
      "MEMORY_IO",
      `safeFs.remove refused: cannot delete the chovy home root (${p})`,
      undefined,
      { op: "remove", path: p },
    );
  }
  try {
    await rm(p, { recursive: true, force: true });
  } catch (err) {
    fail("remove", p, err);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SafeFs {
  read(p: string): Promise<string>;
  /** Atomic write — creates parent directories as needed. */
  write(p: string, content: string): Promise<void>;
  append(p: string, content: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  list(p: string, opts?: { recursive?: boolean }): Promise<string[]>;
  stat(p: string): Promise<{ size: number; mtime: number } | null>;
  /** Removes only paths inside `chovyHome()` — throws MEMORY_IO otherwise. */
  remove(p: string): Promise<void>;
}

export interface SafeFsSync {
  /**
   * Synchronous read for startup paths that must complete before Ink renders
   * (config, features, secrets). Prefer async `safeFs.read` elsewhere.
   */
  read(p: string): string;
}

export const safeFs: SafeFs = {
  read,
  write,
  append,
  exists,
  mkdirp,
  list,
  stat: statOne,
  remove,
};

export const safeFsSync: SafeFsSync = {
  read: readSync,
};
