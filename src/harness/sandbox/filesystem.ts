/**
 * Filesystem sandbox — path blacklist + write/read assertions (step-14).
 *
 * This is the **physical** enforcement layer that backs the permission
 * engine's L1g safety check (`permissions/safety.ts`). Where `safety.ts`
 * inspects the *literal* path a tool received, this module resolves every
 * filesystem representation (original + symlink target + cwd belonging)
 * and refuses writes that:
 *
 *   1. touch a dangerous file/directory (AGENTS.md §5 red lines), OR
 *   2. fall outside the working directory without an explicit allow.
 *
 * The two layers are deliberately kept separate:
 *   - `safety.ts` (L1g) — pure, no `node:fs` calls, fast, runs in the
 *     engine for *every* mode including `bypassPermissions`. It catches
 *     the literal `~/.gitconfig` write.
 *   - `filesystem.ts` (this file) — the *executor*: resolves symlinks,
 *     checks cwd belonging, and is called from inside `file_write` /
 *     `file_edit` `run()` so even a tool whose preflight was bypassed
 *     (mocked ctx, future plugin) cannot escape the blacklist.
 *
 * Spec (step-14 §危险文件 / §与权限引擎的关系):
 *   - "写操作经过 assertWritable(path)" — 4 steps: resolve → follow
 *     symlink → cwd- outside requires explicit allow → blacklist → throw.
 *   - "沙箱是 L1g 安全检查的执行者；被 sandbox 拒绝的写入直接转换为
 *     PERMISSION_DENIED".
 *   - "即使 bypassPermissions 也不能突破沙箱黑名单".
 *
 * We return an `AssertResult` instead of throwing so tool `run()` can map
 * the refusal to a clean `TOOL_DENIED` ToolResult (the model sees why it
 * was refused) rather than an `INTERNAL` error. The errorCode mapping
 * lives in the tool, not here — the sandbox stays policy-agnostic.
 */

import { homedir } from "node:os";
import { sep } from "node:path";

import { chovySecretsDir } from "../../fs/home.js";
import {
  isWithinCwd,
  normalizeCase,
  resolveSymlinkChain,
} from "./allowlist.js";

// ── Blacklists (AGENTS.md §5 red lines, code) ───────────────────────────────

/**
 * Dangerous files whose modification is forbidden outright, regardless of
 * permission mode. These can bootstrap arbitrary code execution or
 * credential exfiltration (shell rc files, git config, npm/pip/netrc
 * credentials). Matches cc-haha's `DANGEROUS_FILES` set + the §5 extras
 * (`.npmrc` / `.pypirc` / `.netrc` / `.kube/config`).
 *
 * Listed by **basename** — the check fires on the last path segment so
 * both `~/.gitconfig` and `/home/u/.gitconfig` trip. The home-relative
 * form in `step-14-sandbox.md` is documentation; enforcement is
 * basename-based (a `.gitconfig` anywhere is dangerous, not just at `~`).
 */
export const DANGEROUS_FILE_NAMES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".npmrc",
  ".pypirc",
  ".netrc",
]);

/**
 * Directory names whose modification is forbidden outright. Matched as
 * path segments anywhere in the resolved path, so `repo/.git/HEAD`,
 * `~/.ssh/id_rsa`, and `proj/.vscode/settings.json` all trip.
 *
 * `.chovy/secrets` is matched as a two-segment prefix (see
 * `matchSecretsDir`); the single-segment `.aws` / `.ssh` / `.git` /
 * `.vscode` / `.idea` use the segment scan.
 */
export const DANGEROUS_DIR_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".vscode",
  ".idea",
]);

// ── Result type ─────────────────────────────────────────────────────────────

export interface AssertResult {
  /** `true` when the path may be written/read. */
  ok: boolean;
  /** Reason surfaced to the model / UI when `ok === false`. */
  reason?: string;
}

const OK: AssertResult = { ok: true };

// ── Internal matchers ───────────────────────────────────────────────────────

/** Split on both separators, drop empty, lowercase for comparison. */
function segments(p: string): string[] {
  return p
    .split(/[\\/]/)
    .filter((s) => s.length > 0)
    .map(normalizeCase);
}

/** Basename (last segment), lowercased for comparison. */
function basename(p: string): string {
  const segs = p.split(/[\\/]/).filter((s) => s.length > 0);
  return segs.length > 0 ? normalizeCase(segs[segs.length - 1]!) : "";
}

/**
 * Does `resolved` touch the `.chovy/secrets` directory? Matched as a
 * two-segment prefix (`.chovy` + `secrets`) so a project dir literally
 * named `secrets` doesn't trip, but `~/.chovy/secrets/anything` does.
 */
function matchSecretsDir(resolved: string): boolean {
  const secretsAbs = normalizeCase(chovySecretsDir());
  const r = normalizeCase(resolved);
  return (
    r === secretsAbs ||
    r.startsWith(secretsAbs + sep) ||
    r.startsWith(secretsAbs + "/")
  );
}

/**
 * Does `resolved` contain a dangerous directory segment, or have a
 * dangerous basename? This is the symlink-aware re-run of
 * `safety.ts`'s `checkPathSafety` — same logic, applied to every
 * representation returned by `resolveSymlinkChain`.
 */
function hitsBlacklist(resolved: string): string | null {
  // `.chovy/secrets` two-segment prefix.
  if (matchSecretsDir(resolved)) {
    return `modifying chovy secrets dir is forbidden: ${resolved}`;
  }

  // `.aws/credentials` exact tail (basename `credentials` under `.aws`).
  if (/(\.aws[\\/])credentials$/i.test(resolved)) {
    return `modifying AWS credentials is forbidden: ${resolved}`;
  }
  // `.kube/config` exact tail.
  if (/(\.kube[\\/])config$/i.test(resolved)) {
    return `modifying kube config is forbidden: ${resolved}`;
  }

  // Basename match for dotfiles.
  const base = basename(resolved);
  if (DANGEROUS_FILE_NAMES.has(base)) {
    return `modifying sensitive file is forbidden: ${resolved}`;
  }

  // Segment scan for dangerous directories.
  for (const seg of segments(resolved)) {
    if (DANGEROUS_DIR_SEGMENTS.has(seg)) {
      return `modifying sensitive directory is forbidden: ${resolved}`;
    }
  }

  return null;
}

/**
 * Is `resolved` inside the home directory? Used by `assertReadable` to
 * allow reads from `~` (e.g. reading a config file for inspection is
 * fine — only *modifying* it is forbidden).
 */
function isWithinHome(resolved: string): boolean {
  const home = homedir();
  const h = normalizeCase(home);
  const r = normalizeCase(resolved);
  if (r === h) return true;
  return r.startsWith(h + sep) || r.startsWith(h + "/");
}

// ── Public assertions ───────────────────────────────────────────────────────

export interface AssertWritableOptions {
  /** Working directory; default `process.cwd()`. */
  cwd?: string;
  /**
   * Paths the caller has explicitly allowed for writes outside cwd (e.g.
   * an `--add-dir` flag, or a project allow rule). Each entry is
   * expanded + symlink-resolved the same way as the target. Default: none.
   */
  allowOutsideCwd?: string[];
}

/**
 * Assert that `path` may be written. Steps (step-14 §危险文件):
 *   1. Expand `~` / make absolute.
 *   2. Resolve every symlink representation (original + realpath + parent).
 *   3. For each representation:
 *        a. Blacklist hit → deny (bypass-immune).
 *        b. Outside cwd AND not in `allowOutsideCwd` → deny.
 *   4. All representations clean → allow.
 *
 * The blacklist check runs on **every** representation so a symlink
 * `evil → ~/.gitconfig` is caught via the resolved form even though the
 * literal `evil` is harmless. The cwd check requires **all**
 * representations to be inside cwd (or an allow entry) — if *any*
 * representation escapes, we deny (defense in depth: a symlinked file
 * whose parent points outside cwd could be a write-elsewhere trap).
 */
export function assertWritable(
  path: string,
  opts: AssertWritableOptions = {},
): AssertResult {
  const cwd = opts.cwd ?? process.cwd();
  const reps = resolveSymlinkChain(path, cwd);

  // 1. Blacklist — any representation hitting it denies the write.
  for (const rep of reps) {
    const hit = hitsBlacklist(rep);
    if (hit !== null) {
      return { ok: false, reason: hit };
    }
  }

  // 2. cwd belonging — every representation must be inside cwd or an
  //    explicit allow entry. Resolve allow entries once.
  const allowRoots = (opts.allowOutsideCwd ?? []).flatMap((a) =>
    resolveSymlinkChain(a, cwd),
  );
  for (const rep of reps) {
    if (isWithinCwd(rep, cwd)) continue;
    const allowed = allowRoots.some((root) => isWithinCwd(rep, root));
    if (!allowed) {
      return {
        ok: false,
        reason: `write outside working directory requires explicit allow: ${rep} (cwd: ${cwd})`,
      };
    }
  }

  return OK;
}

export interface AssertReadableOptions {
  /** Working directory; default `process.cwd()`. */
  cwd?: string;
  /**
   * Paths the caller has explicitly allowed for reads outside cwd+home.
   * Default: none.
   */
  allowOutside?: string[];
}

/**
 * Assert that `path` may be read. Looser than `assertWritable`
 * (step-14 §危险文件: "读操作经过 assertReadable(path)：宽松（默认 home
 * 与 cwd 允许；其他 ask）"):
 *   - Blacklist → deny (reads of `.chovy/secrets`, `.ssh/id_rsa` are
 *     still refused — defense in depth against credential exfiltration).
 *   - Inside cwd OR home → allow.
 *   - Inside an explicit `allowOutside` entry → allow.
 *   - Otherwise → `{ ok: false, reason: "ask" }` — the caller (tool /
 *     engine) decides whether to prompt or deny; we don't block reads of
 *     arbitrary system files outright, we just flag them.
 *
 * The blacklist still applies to every symlink representation so a
 * `cat evil` where `evil → ~/.ssh/id_rsa` is refused.
 */
export function assertReadable(
  path: string,
  opts: AssertReadableOptions = {},
): AssertResult {
  const cwd = opts.cwd ?? process.cwd();
  const reps = resolveSymlinkChain(path, cwd);

  // 1. Blacklist — every representation checked.
  for (const rep of reps) {
    const hit = hitsBlacklist(rep);
    if (hit !== null) {
      return { ok: false, reason: hit };
    }
  }

  // 2. cwd / home / explicit-allow → allow.
  const allowRoots = (opts.allowOutside ?? []).flatMap((a) =>
    resolveSymlinkChain(a, cwd),
  );
  for (const rep of reps) {
    if (isWithinCwd(rep, cwd)) return OK;
    if (isWithinHome(rep)) return OK;
    if (allowRoots.some((root) => isWithinCwd(rep, root))) return OK;
  }

  // 3. Outside everything → "ask" (caller decides). We use reason:"ask"
  //    rather than ok:true so the engine / tool can surface a prompt.
  return {
    ok: false,
    reason: `read outside working directory + home requires permission: ${reps[0] ?? path}`,
  };
}

// ── Convenience: does a path hit the blacklist? (for the engine / tests) ─────

/**
 * Pure blacklist check on a single resolved path — no symlink resolution,
 * no cwd logic. Exposed so the permission engine's L1g (`safety.ts`) and
 * tests can re-use the same matcher without pulling in `node:fs`.
 *
 * `safety.ts` already has its own (literal-only) check; this is the
 * symlink-aware variant the sandbox calls per-representation. The two
 * intentionally overlap (defense in depth).
 */
export function isDangerousPath(resolved: string): boolean {
  return hitsBlacklist(resolved) !== null;
}
