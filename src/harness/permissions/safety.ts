/**
 * Bypass-immune safety checks — layer L1g of the permission engine (step-12).
 *
 * These checks fire for **every** mode, including `bypassPermissions`. They
 * encode the hard red lines from `AGENTS.md §5` (do not modify `~/.gitconfig`,
 * `.bashrc`, `.ssh/*`, project `.git/`, `.chovy/secrets/`; no `--no-verify`;
 * `git push --force` needs confirmation) as code. A tool that trips a safety
 * check is denied (or forced to `ask` for `git push --force`) *before* the
 * mode layer can let it through.
 *
 * Two flavours:
 *   - `checkPathSafety(path)`   — sensitive *files/dirs* (fs tools).
 *   - `checkCommandSafety(cmd)` — dangerous *command patterns* (bash).
 *
 * `probeArgs(toolName, args)` extracts the relevant paths/command from a
 * tool's args so the engine can run both checks uniformly without knowing
 * each tool's schema.
 *
 * Cross-platform notes:
 *   - `.git/` membership is judged by the last path segment so `D:\repo\.git`
 *     and `/repo/.git` both match (we don't rely on a trailing separator).
 *   - `~` / `$HOME` resolution uses `node:os.homedir()`.
 *   - Comparisons are case-insensitive on Windows + macOS (case-insensitive
 *     FS) but left as-is on POSIX — mirroring cc-haha's
 *     `normalizeCaseForComparison` intent without importing its FS layer.
 */

import { homedir, platform } from "node:os";
import { sep } from "node:path";

import { chovySecretsDir } from "../../fs/home.js";

const IS_WIN = platform() === "win32";

/**
 * Files whose modification is forbidden outright (AGENTS.md §5).
 * Shell-rc / git-config / ssh-adjacent dotfiles can bootstrap arbitrary code
 * execution or credential exfiltration, so they are denied regardless of mode.
 */
const DANGEROUS_FILE_NAMES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".npmrc",
  ".netrc",
]);

/**
 * Directory prefixes whose modification is forbidden outright.
 * `.git/` (history/refs), `.ssh/` (keys), `.aws/credentials`, `.chovy/secrets/`.
 * Matched as path segments so `.git/HEAD` and `.ssh/id_rsa` both trip.
 */
const DANGEROUS_DIR_SEGMENTS = new Set([".git", ".ssh", ".aws"]);

export interface SafetyResult {
  /** `true` when the path/command is safe to proceed (subject to mode/rules). */
  safe: boolean;
  /**
   * `deny` for hard red lines (bypass-immune denial); `ask` for `git push
   * --force` (common enough that we prompt rather than hard-deny, per
   * step-12 §安全检查). Only meaningful when `safe === false`.
   */
  level?: "deny" | "ask";
  /** Human-readable reason surfaced to the model / UI. */
  reason?: string;
}

const SAFE: SafetyResult = { safe: true };

/** Lowercase a path for comparison on case-insensitive FS (Win/macOS). */
function norm(p: string): string {
  return IS_WIN || platform() === "darwin" ? p.toLowerCase() : p;
}

/** Last segment of a path, split on both `/` and `\` for cross-platform input. */
function lastSegment(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : "";
}

/**
 * Is `path` a sensitive file/dir whose modification is bypass-immune deny?
 * Resolves `~` against `homedir()` and recognizes both absolute and
 * home-relative inputs.
 */
export function checkPathSafety(path: string): SafetyResult {
  if (!path || typeof path !== "string") return SAFE;

  // Resolve `~` → homedir so `~/.ssh/x` and `/home/u/.ssh/x` match.
  let resolved = path;
  if (resolved.startsWith("~")) {
    resolved = homedir() + resolved.slice(1);
  }
  const n = norm(resolved);
  const homeN = norm(homedir());

  // .chovy/secrets/ — the on-disk secret store (AGENTS.md §5).
  const secretsN = norm(chovySecretsDir());
  if (n === secretsN || n.startsWith(secretsN + sep) || n.startsWith(secretsN + "/")) {
    return { safe: false, level: "deny", reason: `modifying chovy secrets dir is forbidden: ${path}` };
  }

  // File-name match (basename) for dotfiles.
  const base = lastSegment(resolved);
  if (DANGEROUS_FILE_NAMES.has(norm(base))) {
    return { safe: false, level: "deny", reason: `modifying sensitive file is forbidden: ${path}` };
  }

  // .aws/credentials exact-name check (basename 'credentials' under .aws).
  if (/(\.aws[\\/])credentials$/i.test(resolved)) {
    return { safe: false, level: "deny", reason: `modifying AWS credentials is forbidden: ${path}` };
  }

  // Directory-segment match: any path that *contains* a dangerous segment as
  // a real directory component (not a substring). Splits on both separators.
  const segs = resolved.split(/[\\/]/).filter((s) => s.length > 0).map(norm);
  for (const seg of segs) {
    if (DANGEROUS_DIR_SEGMENTS.has(seg)) {
      return { safe: false, level: "deny", reason: `modifying sensitive directory is forbidden: ${path}` };
    }
  }

  // Home-relative shell/git configs that live at ~ (e.g. ~/.gitconfig) are
  // already caught by the basename check above; nothing more to do.
  void homeN;
  return SAFE;
}

/**
 * Is `cmd` a dangerous command pattern that must be denied / asked even in
 * bypass mode?
 *
 *   - `--no-verify` anywhere → deny (AGENTS.md §5: never bypass git hooks).
 *   - `git push --force` / `-f` / `--force-with-lease` → ask (common; the
 *     user may genuinely want it, so we prompt instead of hard-denying).
 *
 * Note: the bash tool's own `evaluateDanger` (step-09) already hard-denies
 * catastrophic patterns (fork bombs, `rm -rf /`, `curl|sh`). This layer is
 * the *bypass-immune* re-check the engine runs regardless of mode — it
 * overlaps with the tool preflight by design (defense in depth).
 */
export function checkCommandSafety(cmd: string): SafetyResult {
  if (!cmd || typeof cmd !== "string") return SAFE;

  // --no-verify: forbidden everywhere (AGENTS.md §5 #3).
  if (/(^|\s)--no-verify(\s|$)/.test(cmd)) {
    return { safe: false, level: "deny", reason: "git --no-verify is forbidden by AGENTS.md §5" };
  }

  // git push --force / -f / --force-with-lease → ask (not deny).
  // Match `git push ... --force`, `git push -f`, `git push --force-with-lease`.
  // We require `push` to appear so `git commit --force` (invalid anyway) and
  // unrelated `--force` flags on other tools don't trip a git-specific rule.
  if (/\bgit\s+push\b/.test(cmd)) {
    if (/(^|\s)--force(\s|$)/.test(cmd) || /(^|\s)--force-with-lease(\s|$)/.test(cmd)) {
      return { safe: false, level: "ask", reason: "git push --force requires explicit confirmation" };
    }
    // `-f` is ambiguous with other git push flags, but combined with `git push`
    // it's overwhelmingly `--force`; prompt to be safe.
    if (/\bgit\s+push\s+.*(^|\s)-f(\s|$)/.test(cmd)) {
      return { safe: false, level: "ask", reason: "git push -f requires explicit confirmation" };
    }
  }

  return SAFE;
}

/**
 * Extract the probeable paths / command from a tool's args, generically.
 *
 * The engine doesn't know each tool's schema, so it looks for the common
 * argument names the built-in tools use:
 *   - fs tools: `path`, `file_path`, `file` (string or string[])
 *   - bash:     `command`, `cmd`
 *
 * Unknown tools / unrecognized shapes return empty probes — the engine then
 * falls back to the tool's own `checkPermissions` preflight (L1c) and the
 * mode/rules layers. A tool that hides a dangerous path in a non-standard
 * arg name will still be caught by its own preflight (e.g. write.ts already
 * calls `safeFs.exists`).
 */
export interface ToolArgsProbe {
  paths: string[];
  command: string | undefined;
}

export function probeArgs(toolName: string, args: unknown): ToolArgsProbe {
  const probe: ToolArgsProbe = { paths: [], command: undefined };
  if (!args || typeof args !== "object") return probe;
  const a = args as Record<string, unknown>;

  // Paths: accept a single string or an array of strings under common keys.
  const pathKeys = ["path", "file_path", "file", "filePath"];
  for (const k of pathKeys) {
    const v = a[k];
    if (typeof v === "string") {
      probe.paths.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") probe.paths.push(item);
      }
    }
  }

  // Command: bash uses `command`; also accept `cmd`.
  const cmdKeys = ["command", "cmd"];
  for (const k of cmdKeys) {
    const v = a[k];
    if (typeof v === "string") {
      probe.command = v;
      break;
    }
  }

  void toolName; // reserved for tool-specific probing in future steps.
  return probe;
}
