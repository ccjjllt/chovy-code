/**
 * Hook settings — `settings.json` loading + matcher parsing (step-13).
 *
 * Settings file shape (from `docs/step-13 §配置`):
 *
 * ```json
 * {
 *   "hooks": [
 *     { "event": "PreToolUse", "matcher": "Bash(*rm*)", "type": "command",
 *       "command": "echo '⚠️ rm detected' >&2", "timeoutMs": 1000 },
 *     { "event": "PermissionRequest", "matcher": "*", "type": "command",
 *       "command": "echo '{\"ok\":false,\"reason\":\"policy\"}'" }
 *   ]
 * }
 * ```
 *
 * Loaded from two paths, merged in order (project augments user):
 *   1. `~/.chovy/settings.json`       — user-wide.
 *   2. `<cwd>/.chovy/settings.json`   — project-local.
 *
 * Matcher syntax (reuses the permission-rules grammar from step-12
 * `rules.ts` — `*` ↔ `.*`, `\*` ↔ literal — so users learn one syntax):
 *   - `"*"`            → matches every tool (and non-tool events).
 *   - `"bash"`         → matches tool `bash` exactly (any args).
 *   - `"bash(*rm*)"`   → matches `bash` whose content (command / path)
 *                        matches the wildcard `*rm*`.
 *
 * Robustness mirrors `rules.ts`: malformed JSON / individual entries are
 * skipped + logged, never thrown — a typo in `settings.json` must not
 * brick the agent. BOM is stripped (§15 Windows config convention).
 *
 * The matcher logic is intentionally a *trimmed* reimplementation of
 * `rules.ts`'s `matchWildcardPattern` rather than an import: rules.ts
 * parses `Tool(prefix:*)` legacy syntax which hooks don't use, and
 * importing it would pull the permission engine's rule types into the
 * hook layer. The two grammars share `*` semantics but live separately.
 */

import { join } from "node:path";
import { z } from "zod";

import { safeFsSync } from "../../fs/index.js";
import { chovyHome } from "../../fs/home.js";
import { logger } from "../../logger/index.js";
import { ChovyError } from "../../types/errors.js";
import type { HookConfig, HookEvent } from "../../types/hook.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default per-hook timeout (spec §风险: "默认 timeoutMs=2000"). */
export const DEFAULT_HOOK_TIMEOUT_MS = 2_000;
/** Hard cap so a single hook can't block the agent for too long (spec §风险). */
export const MAX_HOOK_TIMEOUT_MS = 10_000;

// ── zod schema ─────────────────────────────────────────────────────────────

const HookEventSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "GoalIteration",
  "SubAgentSpawn",
  "CheckpointWritten",
]);

const HookConfigSchema = z.object({
  event: HookEventSchema,
  matcher: z.string().optional(),
  type: z.enum(["command", "function"]),
  command: z.string().optional(),
  path: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(MAX_HOOK_TIMEOUT_MS).optional(),
  managed: z.boolean().optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.type === "command" && (typeof cfg.command !== "string" || cfg.command.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'hooks entry with type:"command" requires a non-empty "command"',
      path: ["command"],
    });
  }
  if (cfg.type === "function" && (typeof cfg.path !== "string" || cfg.path.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'hooks entry with type:"function" requires a non-empty "path"',
      path: ["path"],
    });
  }
});

const SettingsFileSchema = z.object({
  hooks: z.array(HookConfigSchema).optional(),
}).passthrough(); // allow other settings keys chovy doesn't own yet

export type SettingsFile = z.infer<typeof SettingsFileSchema>;

// ── Loading ────────────────────────────────────────────────────────────────

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** Pull the original `errno` out of a ChovyError(MEMORY_IO) safeFs wrapper. */
function errnoOf(err: unknown): string | undefined {
  const meta = err instanceof ChovyError ? err.meta : undefined;
  const errno = meta?.["errno"];
  return typeof errno === "string" ? errno : undefined;
}

/**
 * Parse a settings JSON blob into `HookConfig[]`. Malformed JSON / invalid
 * entries are skipped + logged; never throws.
 */
export function loadSettingsFromText(json: string, source: string): HookConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(json));
  } catch (err) {
    logger.warn(`hook settings: invalid JSON in ${source}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const result = SettingsFileSchema.safeParse(parsed);
  if (!result.success) {
    // Log each issue but keep going — a single bad entry shouldn't drop the
    // whole file. Re-parse entry-by-entry to salvage the valid ones.
    logger.warn(`hook settings: schema errors in ${source}`, {
      issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return salvageValidHooks(parsed, source);
  }
  return withDefaultTimeouts(result.data.hooks ?? []);
}

/**
 * Best-effort salvage: parse the `hooks` array raw and keep entries that
 * validate individually. A misconfigured sibling shouldn't sink a good
 * hook. Mirrors `rules.ts`'s per-entry resilience.
 */
function salvageValidHooks(parsed: unknown, source: string): HookConfig[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const arr = (parsed as { hooks?: unknown }).hooks;
  if (!Array.isArray(arr)) return [];
  const out: HookConfig[] = [];
  for (const entry of arr) {
    const r = HookConfigSchema.safeParse(entry);
    if (r.success) out.push(...withDefaultTimeouts([r.data]));
    else {
      logger.warn(`hook settings: skipping invalid entry in ${source}`, {
        issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
  }
  return out;
}

/** Fill in the default timeout for hooks that didn't specify one. */
function withDefaultTimeouts(hooks: HookConfig[]): HookConfig[] {
  return hooks.map((h) => ({
    ...h,
    timeoutMs: clampTimeout(h.timeoutMs),
  }));
}

/** Clamp a hook's timeout to [1, MAX]; undefined → default. */
export function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 1) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(Math.floor(ms), MAX_HOOK_TIMEOUT_MS);
}

/**
 * Load + merge hook settings from a list of file paths. Missing files are
 * silently skipped (the common case). Read errors other than ENOENT are
 * logged + skipped, never thrown.
 */
export function loadSettingsFromPaths(paths: string[]): HookConfig[] {
  const out: HookConfig[] = [];
  for (const p of paths) {
    let raw: string;
    try {
      raw = safeFsSync.read(p);
    } catch (err) {
      const code = errnoOf(err);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      logger.warn(`hook settings: failed to read ${p}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const h of loadSettingsFromText(raw, p)) out.push(h);
  }
  return out;
}

/** The default settings search paths: `~/.chovy/settings.json` + `<cwd>/.chovy/settings.json`. */
export function defaultSettingsPaths(cwd: string): string[] {
  return [join(chovyHome(), "settings.json"), join(cwd, ".chovy", "settings.json")];
}

// ── Matching ───────────────────────────────────────────────────────────────

/**
 * A compiled matcher. `toolName` is the exact tool name to match (or
 * `undefined` for `"*"` / non-tool events). `contentPattern` is the
 * wildcard pattern (already regex-escaped) applied to the tool's content
 * string, or `undefined` when the matcher is tool-name-only.
 */
export interface CompiledMatcher {
  toolName: string | undefined;
  contentPattern: RegExp | undefined;
  /** Original matcher string, for telemetry / error messages. */
  raw: string;
}

/**
 * Compile a matcher string into a `CompiledMatcher`. Returns a matcher
 * that matches nothing on malformed input (fail-safe: a bad matcher
 * shouldn't fire spuriously).
 *
 * Grammar:
 *   - `"*"`              → match everything (toolName undefined, no content).
 *   - `"bash"`           → match tool `bash`, any content.
 *   - `"bash(*rm*)"`     → match tool `bash`, content matches `*rm*`.
 *   - `"bash(npm test)"` → match tool `bash`, content equals `npm test`.
 */
export function compileMatcher(matcher: string | undefined): CompiledMatcher {
  const raw = (matcher ?? "*").trim();
  if (raw === "" || raw === "*") {
    return { toolName: undefined, contentPattern: undefined, raw };
  }
  // `Tool(content)` form?
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open > 0 && close > open && close === raw.length - 1) {
    const toolName = raw.slice(0, open).trim();
    const content = raw.slice(open + 1, close);
    if (toolName === "" ) {
      return { toolName: undefined, contentPattern: undefined, raw };
    }
    if (content === "" || content === "*") {
      return { toolName, contentPattern: undefined, raw };
    }
    return { toolName, contentPattern: wildcardToRegex(content), raw };
  }
  // Bare tool name, no parens.
  return { toolName: raw, contentPattern: undefined, raw };
}

/**
 * Does `matcher` apply to a `(toolName, content)` invocation? Non-tool
 * events (SessionStart, GoalIteration, …) pass `toolName: undefined` and
 * only the `"*"` matcher matches them.
 */
export function matchesHook(
  matcher: CompiledMatcher,
  toolName: string | undefined,
  content: string,
): boolean {
  // Non-tool event: only the catch-all matches.
  if (toolName === undefined) {
    return matcher.toolName === undefined && matcher.contentPattern === undefined;
  }
  // Catch-all matcher matches any tool.
  if (matcher.toolName === undefined && matcher.contentPattern === undefined) {
    return true;
  }
  // Tool-name-only matcher.
  if (matcher.toolName !== undefined && matcher.contentPattern === undefined) {
    return matcher.toolName === toolName;
  }
  // Tool + content matcher.
  if (matcher.toolName !== undefined && matcher.contentPattern !== undefined) {
    if (matcher.toolName !== toolName) return false;
    return matcher.contentPattern.test(content);
  }
  return false;
}

/**
 * Convert a wildcard pattern (`*` ↔ any chars, `\*` ↔ literal `*`, `\\` ↔
 * literal `\`) into a RegExp. A *new* RegExp is built per compile (never
 * reused) so the `g`-flag `lastIndex` pitfall (AGENTS.md §16) can't bite.
 * `s` (dotAll) so `*` spans embedded newlines (heredoc content).
 *
 * This is a trimmed port of `rules.ts`'s `matchWildcardPattern` escape
 * logic — kept here so the hook layer doesn't reach into the permission
 * engine's rule types.
 */
function wildcardToRegex(pattern: string): RegExp {
  let processed = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1]!;
      if (next === "*") {
        processed += "\x00STAR\x00";
        i += 2;
        continue;
      }
      if (next === "\\") {
        processed += "\x00BSLASH\x00";
        i += 2;
        continue;
      }
    }
    processed += ch;
    i++;
  }
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  const withWild = escaped.replace(/\*/g, ".*");
  const final = withWild
    .replace(/\x00STAR\x00/g, "\\*")
    .replace(/\x00BSLASH\x00/g, "\\\\");
  return new RegExp(`^${final}$`, "s");
}

/**
 * The "content" string a hook matcher tests against for a given event.
 * For tool events it's the command (bash) or first path (fs tools); for
 * non-tool events it's empty (the matcher only sees the tool name). Kept
 * narrow to avoid pulling the full `safety.ts` probeArgs.
 */
export function hookContentFor(toolName: string | undefined, args: unknown): string {
  if (!toolName || !args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const cmd = a["command"];
  if (typeof cmd === "string") return cmd;
  const path = a["path"] ?? a["file_path"] ?? a["filePath"];
  if (typeof path === "string") return path;
  return "";
}

/** Convenience: the list of events that carry a `toolName` payload. */
export const TOOL_SCOPED_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
] as const;
