/**
 * Permission rules — user/project `rules.json` loading + matching (step-12).
 *
 * Rules file shape (from `docs/step-12 §规则文件`):
 *
 * ```json
 * {
 *   "allow": ["Glob", "Grep", "Read", "Bash(npm test:*)"],
 *   "ask":   ["Bash(git push:*)"],
 *   "deny":  ["Bash(rm -rf:*)"]
 * }
 * ```
 *
 * Matching syntax (cc-haha `permissionRuleParser` + `shellRuleMatching`,
 * trimmed to chovy's needs):
 *   - `Tool`                 — matches the whole tool (any args).
 *   - `Tool(prefix:*)`       — legacy prefix syntax: `prefix` must start the
 *                              tool's content (e.g. command line).
 *   - `Tool(*wild*card*)`    — wildcard: `*` matches any run of chars; `\*`
 *                              matches a literal `*`, `\\` a literal `\`.
 *
 * Loaded from two paths, merged in order (project rules augment user rules):
 *   1. `~/.chovy/rules.json`        — user-wide.
 *   2. `<cwd>/.chovy/rules.json`    — project-local (wins on conflict by
 *      being later in the list; the engine applies deny > ask > allow
 *      precedence regardless of source order, so "wins" only matters within
 *      the same behavior bucket).
 *
 * Robustness: a malformed file or individual rule is skipped + logged, never
 * thrown — a typo in `rules.json` must not brick the agent. BOM is stripped
 * (Windows config files often carry one — §15 Phase A 追记).
 */

import { join } from "node:path";

import { safeFsSync } from "../../fs/index.js";
import { chovyHome } from "../../fs/home.js";
import { logger } from "../../logger/index.js";
import { ChovyError } from "../../types/errors.js";

export type RuleBehavior = "allow" | "ask" | "deny";

export interface RuleFile {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/**
 * A parsed rule. `kind` drives the matcher:
 *   - `whole`   — rule had no content (e.g. `"Bash"`); matches the tool only.
 *   - `prefix`  — `Tool(prefix:*)` legacy syntax.
 *   - `wildcard`— content contains unescaped `*` (and isn't `:*` suffix).
 *   - `exact`   — content with no wildcards (e.g. `Bash(npm test)`).
 */
export interface ParsedRule {
  behavior: RuleBehavior;
  toolName: string;
  /** Raw content between the parens, or undefined for whole-tool rules. */
  content?: string;
  kind: "whole" | "prefix" | "wildcard" | "exact";
}

const BEHAVIORS: readonly RuleBehavior[] = ["allow", "ask", "deny"];

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Does `pattern` contain an unescaped `*` that is NOT the legacy `:*` suffix?
 * Mirrors cc-haha `hasWildcards` (shellRuleMatching.ts).
 */
function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false; // legacy prefix syntax
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "*") continue;
    // Count preceding backslashes; even (incl. 0) ⇒ unescaped.
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && pattern[j] === "\\") {
      backslashes++;
      j--;
    }
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

/**
 * Find the first unescaped occurrence of `ch` in `s`. Returns -1 if none.
 * A char is "unescaped" when preceded by an even number of backslashes.
 */
function firstUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ch) continue;
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && s[j] === "\\") {
      backslashes++;
      j--;
    }
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/** Reverse-escape `\(`→`(`, `\)`→`)`, `\\`→`\` in rule content. */
function unescapeContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

/**
 * Parse a single rule string into a `ParsedRule`.
 *
 * @example
 * parseRuleString("Bash")                 // whole
 * parseRuleString("Bash(npm test:*)")     // prefix "npm test"
 * parseRuleString("Bash(rm -rf:*)", "deny") // prefix "rm -rf"
 * parseRuleString("Bash(*build*)")        // wildcard
 * parseRuleString("Bash(npm test)")       // exact
 */
export function parseRuleString(s: string, behavior: RuleBehavior): ParsedRule {
  const trimmed = s.trim();
  const open = firstUnescaped(trimmed, "(");
  if (open === -1) {
    return { behavior, toolName: trimmed, kind: "whole" };
  }
  // Last unescaped ')'.
  let close = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] !== ")") continue;
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && trimmed[j] === "\\") {
      backslashes++;
      j--;
    }
    if (backslashes % 2 === 0) {
      close = i;
      break;
    }
  }
  // Malformed (no closing paren, or content after it) → treat as whole tool.
  if (close === -1 || close !== trimmed.length - 1) {
    return { behavior, toolName: trimmed, kind: "whole" };
  }
  const toolName = trimmed.slice(0, open);
  const raw = trimmed.slice(open + 1, close);
  if (!toolName || raw === "" || raw === "*") {
    return { behavior, toolName: toolName || trimmed, kind: "whole" };
  }
  const content = unescapeContent(raw);

  // Legacy `prefix:*` → prefix match on `prefix`.
  const prefixMatch = content.match(/^(.+):\*$/);
  if (prefixMatch) {
    return { behavior, toolName, content: prefixMatch[1], kind: "prefix" };
  }
  if (hasWildcards(content)) {
    return { behavior, toolName, content, kind: "wildcard" };
  }
  return { behavior, toolName, content, kind: "exact" };
}

/** Inverse of `parseRuleString` for display / persistence. */
export function ruleToString(r: ParsedRule): string {
  if (r.kind === "whole" || r.content === undefined) return r.toolName;
  // Re-escape parens + backslashes for round-trip safety.
  const escaped = r.content
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  return `${r.toolName}(${escaped})`;
}

// ── Matching ───────────────────────────────────────────────────────────────

/**
 * Match a wildcard pattern against `content`. `*` ↔ `.*`, `\*` ↔ literal `*`,
 * `\\` ↔ literal `\`. A *new* RegExp is built per call (never reused) so the
 * `lastIndex` pitfall noted in AGENTS.md §16 can't bite.
 */
export function matchWildcardPattern(pattern: string, content: string): boolean {
  const trimmed = pattern.trim();
  let processed = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length) {
      const next = trimmed[i + 1]!;
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
  // Escape regex specials except `*`.
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  const withWild = escaped.replace(/\*/g, ".*");
  const final = withWild
    .replace(/\x00STAR\x00/g, "\\*")
    .replace(/\x00BSLASH\x00/g, "\\\\");
  // `s` (dotAll) so `*` matches embedded newlines (heredoc content etc.).
  return new RegExp(`^${final}$`, "s").test(content);
}

/**
 * Does `rule` match a tool invocation `(toolName, content)`?
 *
 * `content` is the tool-specific string the rule's content would compare
 * against — for `bash` it's the command line, for fs tools the path, etc.
 * Whole-tool rules match on `toolName` only (content ignored).
 */
export function matchRule(rule: ParsedRule, toolName: string, content: string): boolean {
  if (rule.toolName !== toolName) return false;
  switch (rule.kind) {
    case "whole":
      return true;
    case "exact":
      return rule.content === content;
    case "prefix":
      // `prefix:*` ⇒ content starts with prefix (trimmed). An empty content
      // never matches a prefix rule (a prefix implies *something* follows).
      return content.startsWith(rule.content ?? "");
    case "wildcard":
      return matchWildcardPattern(rule.content ?? "", content);
    default:
      return false;
  }
}

// ── Loading ────────────────────────────────────────────────────────────────

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Pull the original `errno` out of a `ChovyError(MEMORY_IO)` that `safeFs`
 * wraps around node fs errors (mirrors `features.ts`/`config.ts`). Returns
 * undefined for non-ChovyError or errors without an errno.
 */
function errnoOf(err: unknown): string | undefined {
  const meta = err instanceof ChovyError ? err.meta : undefined;
  const errno = meta?.["errno"];
  return typeof errno === "string" ? errno : undefined;
}

/**
 * Parse a rules JSON blob into `ParsedRule[]`. Malformed JSON or non-array
 * buckets are skipped + logged; never throws.
 */
export function loadRulesFromText(json: string, source: string): ParsedRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(json));
  } catch (err) {
    logger.warn(`permission rules: invalid JSON in ${source}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn(`permission rules: ${source} is not a JSON object`);
    return [];
  }
  const obj = parsed as RuleFile;
  const out: ParsedRule[] = [];
  for (const behavior of BEHAVIORS) {
    const arr = obj[behavior];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry !== "string") {
        logger.warn(`permission rules: non-string entry in ${source}.${behavior}`, { entry });
        continue;
      }
      try {
        out.push(parseRuleString(entry, behavior));
      } catch (err) {
        logger.warn(`permission rules: failed to parse "${entry}" in ${source}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return out;
}

/**
 * Load + merge rules from a list of file paths. Missing files are silently
 * skipped (the common case — most users have no `rules.json`). Read errors
 * other than ENOENT are logged and skipped, never thrown.
 *
 * Returns the rules bucketed by behavior for the engine's deny>ask>allow
 * precedence walk.
 */
export function loadRulesFromPaths(
  paths: string[],
): { allow: ParsedRule[]; ask: ParsedRule[]; deny: ParsedRule[] } {
  const allow: ParsedRule[] = [];
  const ask: ParsedRule[] = [];
  const deny: ParsedRule[] = [];
  for (const p of paths) {
    let raw: string;
    try {
      raw = safeFsSync.read(p);
    } catch (err) {
      // safeFs wraps node errors in ChovyError(MEMORY_IO) with the original
      // errno in `meta.errno`. Missing file is the common case (most users
      // have no rules.json) → skip silently. Other errors → log + skip.
      const code = errnoOf(err);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      logger.warn(`permission rules: failed to read ${p}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const r of loadRulesFromText(raw, p)) {
      if (r.behavior === "allow") allow.push(r);
      else if (r.behavior === "ask") ask.push(r);
      else deny.push(r);
    }
  }
  return { allow, ask, deny };
}

/** The default rule-file search paths: `~/.chovy/rules.json` + `<cwd>/.chovy/rules.json`. */
export function defaultRulesPaths(cwd: string): string[] {
  return [join(chovyHome(), "rules.json"), join(cwd, ".chovy", "rules.json")];
}
