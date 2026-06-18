/**
 * Path allowlist & triple-resolution (step-14 sandbox foundation).
 *
 * The permission engine's L1g safety check (`permissions/safety.ts`) only
 * inspects the *literal* path string a tool received. That's not enough: a
 * symlink `evil → ~/.gitconfig` defeats a basename check on `"evil"`. This
 * module supplies the three representations every write must be validated
 * against, lifted from cc-haha's `getPathsForPermissionCheck` +
 * `pathInWorkingPath`:
 *
 *   1. **Original**  — the path as the tool received it (`~`-expanded,
 *      made absolute). Catches the obvious cases.
 *   2. **Resolved**  — `fs.realpathSync` followed to the final target.
 *      Catches symlink escape (`evil → ~/.gitconfig`).
 *   3. **Cwd-belonging** — is *any* representation inside the working
 *      directory? Writes outside cwd require an explicit allow entry.
 *
 * Design notes:
 *   - Pure leaf module: only `node:fs` + `node:os` + `node:path`. The
 *     harness→tools edge rule (AGENTS.md §18) says harness modules may
 *     reach zero-dependency tool leaves; this file is itself a leaf and
 *     imports nothing from `src/tools/`, so there's no cycle.
 *   - `realpathSync` is best-effort: a not-yet-existing target (a file
 *     the tool is about to *create*) can't be resolved. In that case we
 *     resolve the **parent** directory and re-append the basename — this
 *     still catches a symlinked parent pointing outside cwd, which is the
 *     realistic escape vector. Total failure → fall back to the original
 *     path (we never block a legitimate write because resolution failed).
 *   - Case-insensitive comparison on Windows + macOS mirrors
 *     `safety.ts`'s `norm()`; POSIX is left as-is (case-sensitive FS).
 */

import { realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const IS_WIN = platform() === "win32";
const IS_DARWIN = platform() === "darwin";

/**
 * Lowercase a path for comparison on case-insensitive filesystems
 * (Windows, macOS). POSIX paths keep their case — a case-sensitive FS
 * means `.Git` and `.git` are genuinely different directories, and
 * lowercasing would create false matches.
 */
export function normalizeCase(p: string): string {
  return IS_WIN || IS_DARWIN ? p.toLowerCase() : p;
}

/**
 * Expand `~` / `$HOME` / `${HOME}` to the user's home directory and make
 * the path absolute against `cwd` (default `process.cwd()`). Mirrors the
 * conservative expansion the bash tool already does, so a path the model
 * hands to `file_write` resolves identically here and in the shell.
 *
 * Unlike cc-haha's `expandPath` we do NOT touch `~user`, `~+`, `~-` —
 * those are shell-side expansions and accepting them here would open a
 * TOCTOU gap (we'd validate a literal `~root` that bash later expands to
 * `/var/root`). Callers receiving such a path will simply see it treated
 * as relative, which the cwd check then flags as outside cwd.
 */
export function expandPath(p: string, cwd?: string): string {
  if (!p || typeof p !== "string") return p;
  const base = cwd ?? process.cwd();
  let s = p;

  // `~` or `~/...` or `~\...` (Windows) → homedir.
  if (s === "~" || s.startsWith("~/") || (IS_WIN && s.startsWith("~\\"))) {
    s = homedir() + s.slice(1);
  }

  // `$HOME` / `${HOME}` only as a leading token — mid-path `$HOME` is the
  // shell's job, and accepting it mid-path would mask injection. We match
  // the bash tool's leading-token rule.
  if (s === "$HOME") s = homedir();
  else if (s.startsWith("$HOME/") || (IS_WIN && s.startsWith("$HOME\\"))) {
    s = homedir() + s.slice(5);
  } else if (s.startsWith("${HOME}/") || (IS_WIN && s.startsWith("${HOME}\\"))) {
    s = homedir() + s.slice(7);
  }

  return isAbsolute(s) ? resolve(s) : resolve(base, s);
}

/**
 * Resolve every filesystem representation of `path`:
 *   - the expanded absolute path (always present),
 *   - the `realpathSync` of the target if it exists,
 *   - otherwise the `realpathSync` of the parent dir + basename.
 *
 * Duplicates are removed. Resolution failures (ENOENT, EACCES, EPERM on
 * every step) fall back to the expanded path — we never throw, callers
 * treat the returned list as "everything this path could be".
 *
 * This is the chovy-code equivalent of cc-haha's
 * `getPathsForPermissionCheck`: the same set of representations, validated
 * together so a single symlink escape can't slip past.
 */
export function resolveSymlinkChain(p: string, cwd?: string): string[] {
  const expanded = expandPath(p, cwd);
  const out: string[] = [expanded];
  const seen = new Set<string>([normalizeCase(expanded)]);

  const add = (candidate: string | null): void => {
    if (candidate === null) return;
    const key = normalizeCase(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  // 1. Direct realpath — works when the target already exists.
  add(tryRealpath(expanded));

  // 2. Parent realpath + basename — works for not-yet-existing files
  //    (the common "create new file" case). Resolving the parent still
  //    catches a symlinked directory leading outside cwd.
  const parent = dirname(expanded);
  const parentReal = tryRealpath(parent);
  if (parentReal !== null && parentReal !== parent) {
    add(join(parentReal, expanded.slice(parent.length)));
  }

  return out;
}

/** Best-effort `realpathSync`; returns `null` on any failure. */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Is `path` equal to or nested inside `cwd`? Compares the normalized
 * absolute forms so trailing separators and `..` collapse don't fool us.
 * Cross-platform: treats both `/` and `\` as separators on Windows.
 *
 * Used by `assertWritable` to decide whether a write needs an explicit
 * outside-cwd allow entry. cc-haha's `pathInWorkingPath` does the same
 * check (plus a macOS `/private` symlink quirk we don't need — our
 * `resolveSymlinkChain` already resolves symlinks explicitly).
 */
export function isWithinCwd(path: string, cwd: string): boolean {
  const a = resolve(path);
  const b = resolve(cwd);
  if (a === b) return true;
  const aN = normalizeCase(a);
  const bN = normalizeCase(b);
  if (aN === bN) return true;
  // `a` must start with `b` + separator. On Windows both `/` and `\`
  // separate path components; we accept either after the cwd prefix.
  return aN.startsWith(bN + sep) || aN.startsWith(bN + "/");
}

/**
 * Convenience: all distinct representations of `path` that fall inside
 * `cwd`. An empty result means *no* representation is inside cwd — i.e.
 * the write target is unambiguously outside the working directory.
 */
export function representationsInsideCwd(
  path: string,
  cwd: string,
): string[] {
  return resolveSymlinkChain(path, cwd).filter((rep) => isWithinCwd(rep, cwd));
}
