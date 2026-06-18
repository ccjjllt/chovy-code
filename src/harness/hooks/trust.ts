/**
 * Workspace trust — the boundary that gates user-supplied hooks (step-13).
 *
 * Untrusted workspaces may only run *managed* hooks (chovy built-ins); a
 * user/project command/function hook from `settings.json` is refused. This
 * is the defense-in-depth layer cc-haha enforces via
 * `shouldSkipHookDueToTrust` (its `utils/hooks.ts:289`) — chovy-code
 * implements it as a small JSON file instead of cc-haha's nested
 * `config.projects[<path>].hasTrustDialogAccepted` graph, because chovy
 * has no settings layer yet (step-22 owns the trust *dialog* UI).
 *
 * Trust state file: `~/.chovy/trust.json`
 *   { "<normalizedCwd>": true, ... }
 *
 * Normalization mirrors `src/fs/paths.ts` (resolve + Windows lowercase
 * drive + `\`→`/`) so `D:\Foo` and `d:/foo` share one key. ENOENT is the
 * common case (fresh install) → treated as untrusted, silently.
 *
 * Trust only transitions false→true during a session and is persisted to
 * disk; step-22's trust dialog will call `markTrusted(cwd)` when the user
 * accepts. This module is pure I/O + no UI so it can be unit-tested and
 * reused by both the CLI and sub-agent paths.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { platform } from "node:os";

import { chovyHome } from "../../fs/home.js";
import { logger } from "../../logger/index.js";
import { ChovyError } from "../../types/errors.js";

const IS_WIN = platform() === "win32";

/** Absolute path to the trust state file. */
export function trustFilePath(): string {
  return resolve(chovyHome(), "trust.json");
}

/**
 * Normalize a cwd into the stable key used in trust.json. Mirrors
 * `src/fs/paths.ts` normalization so both modules agree on a project's
 * identity. Keeping a private copy here avoids a harness→fs/paths dep
 * edge for a single helper (paths.ts also creates project dirs, which is
 * more than trust needs).
 */
export function normalizeCwdKey(cwd: string): string {
  let p = resolve(cwd);
  if (IS_WIN) {
    p = p.replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase() + ":");
    p = p.split(sep).join("/");
  }
  return p;
}

interface TrustFile {
  [cwdKey: string]: boolean;
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Read the trust file. Missing / malformed → empty (untrusted). safeFs is
 * async-only; the trust check runs on the hot hook path and at startup,
 * so a sync read is acceptable here (mirrors the config/features sync
 * read pattern). Errors other than ENOENT are logged + treated as empty.
 */
function readTrustFile(): TrustFile {
  const path = trustFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    logger.warn("trust: failed to read trust file", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  try {
    const parsed = JSON.parse(stripBom(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TrustFile;
  } catch (err) {
    logger.warn("trust: invalid JSON in trust file", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** Write the trust file (best-effort; failure is logged, not thrown). */
function writeTrustFile(data: TrustFile): void {
  const path = trustFilePath();
  try {
    mkdirSync(chovyHome(), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (err) {
    logger.warn("trust: failed to write trust file", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Is `cwd` (or any ancestor) marked trusted? Trust inherits downward —
 * trusting `~/dev` trusts `~/dev/chovy-code` without a separate entry.
 * This mirrors cc-haha's parent-traversal in `computeTrustDialogAccepted`.
 */
export function isTrusted(cwd: string): boolean {
  const data = readTrustFile();
  let current = normalizeCwdKey(cwd);
  // Walk up; stop at the root (parent === self).
  while (true) {
    if (data[current] === true) return true;
    const parent = normalizeCwdKey(resolve(current, ".."));
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Mark `cwd` trusted. Idempotent. Step-22's trust dialog calls this when
 * the user accepts; tests call it to seed a trusted workspace.
 */
export function markTrusted(cwd: string): void {
  const data = readTrustFile();
  const key = normalizeCwdKey(cwd);
  if (data[key] === true) return;
  data[key] = true;
  writeTrustFile(data);
}

/**
 * Revoke trust for `cwd` exactly (does not touch ancestors). Primarily a
 * test helper; step-22 may expose a `/untrust` slash command later.
 */
export function revokeTrust(cwd: string): void {
  const data = readTrustFile();
  const key = normalizeCwdKey(cwd);
  if (!(key in data)) return;
  delete data[key];
  writeTrustFile(data);
}

/**
 * Should the hook engine refuse user/project hooks and only run managed
 * (chovy built-in) hooks? True when `cwd` is untrusted.
 *
 * Managed hooks (chovy's own, e.g. a future GoalIteration telemetry hook)
 * always run — they ship in the binary and aren't user-authorable, so
 * they can't bootstrap arbitrary code the way a `command` hook can.
 */
export function shouldAllowManagedHooksOnly(cwd: string): boolean {
  return !isTrusted(cwd);
}

/** Pull the original `errno` out of a node fs error / ChovyError wrapper. */
function errnoOf(err: unknown): string | undefined {
  if (err instanceof ChovyError) {
    const errno = err.meta?.["errno"];
    return typeof errno === "string" ? errno : undefined;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
