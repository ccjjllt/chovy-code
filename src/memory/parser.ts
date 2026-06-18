/**
 * MEMORY.md / notes.md / progress.md parser (step-24 §解析 MEMORY.md).
 *
 * Two-stage strategy:
 *
 *   1. Strip a leading `---\n…\n---\n` frontmatter block (YAML-ish; we
 *      only honor a tiny vocabulary so we can avoid a real YAML parser).
 *      Recognized keys:
 *        chovy_memory: bool   — gate; if missing/falsey we still parse
 *                               (keeps human-edited MEMORY.md working
 *                               without a magic header).
 *        default_type: <T>    — fallback type when a bullet omits one.
 *        default_importance: <0..100>
 *
 *   2. Walk the body. Each `## Heading` starts a *section* (heading text
 *      is recorded as a tag); each `- ` bullet inside is a candidate
 *      record. Bullet shapes:
 *
 *        - decision(80): we use Bun + Ink, not Node    → type=decision, imp=80
 *        - rule: prefer explicit return types          → type=rule, imp=default(50)
 *        - production deploy is via GH Actions         → type=default('fact'), imp=default(40)
 *
 *      Multiline bullets (continuation lines indented or starting with a
 *      non-`-` non-`#` character) get folded onto the parent bullet.
 *
 * Anything we can't classify falls back to `{type:'fact', importance:40}`
 * with the section heading as a tag — that's the spec's "未解析的段落作为
 * layer=project, type=fact, importance=40 入库（保底）" rule.
 *
 * The parser is intentionally **lossless on round-trip metadata**:
 * `sourceLine` is recorded for each bullet so future steps (step-25 jump-
 * to-source, step-26 checkpoint diff) can show the user the exact line
 * the memory came from.
 */

import { MEMORY_TYPES } from "../types/memory.js";
import type { MemoryLayer, MemoryType } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FrontmatterMeta {
  chovyMemory: boolean;
  defaultType: MemoryType;
  defaultImportance: number;
  /** Raw key/value pairs we didn't recognize — kept for diagnostics. */
  extras: Record<string, string>;
}

export interface ParsedMemory {
  type: MemoryType;
  importance: number;
  content: string;
  /** 1-indexed line number of the bullet's first line in the source. */
  sourceLine: number;
  /** Section heading the bullet was nested under (lower-cased, trimmed). */
  tags: string[];
}

export interface ParseResult {
  meta: FrontmatterMeta;
  records: ParsedMemory[];
  /** Whether the file claimed to be chovy-managed via `chovy_memory: true`. */
  managed: boolean;
}

// ---------------------------------------------------------------------------
// Defaults — exported so files/memoryFile.ts can use them when a brand-new
// MEMORY.md is created.
// ---------------------------------------------------------------------------

export const DEFAULT_TYPE: MemoryType = "fact";
export const DEFAULT_IMPORTANCE = 50;
/** Lower default for unstructured prose (spec §"保底"). */
export const FALLBACK_IMPORTANCE = 40;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const FM_FENCE = "---";

/**
 * Strip a leading `---\n…\n---\n` block. Returns the parsed meta + the body
 * (with the frontmatter removed) + the *line offset* of the body so we can
 * report accurate `sourceLine` numbers downstream.
 */
function stripFrontmatter(raw: string): {
  meta: FrontmatterMeta;
  body: string;
  bodyLineOffset: number;
} {
  const meta: FrontmatterMeta = {
    chovyMemory: false,
    defaultType: DEFAULT_TYPE,
    defaultImportance: DEFAULT_IMPORTANCE,
    extras: {},
  };

  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== FM_FENCE) {
    return { meta, body: raw, bodyLineOffset: 0 };
  }

  // Find the closing fence. If absent within the first 50 lines, treat the
  // whole document as body — defensive against half-written frontmatters.
  let close = -1;
  const SCAN_LIMIT = Math.min(lines.length, 50);
  for (let i = 1; i < SCAN_LIMIT; i++) {
    if (lines[i]?.trim() === FM_FENCE) {
      close = i;
      break;
    }
  }
  if (close === -1) return { meta, body: raw, bodyLineOffset: 0 };

  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase().replace(/-/g, "_");
    const value = (m[2] ?? "").trim();
    switch (key) {
      case "chovy_memory":
        meta.chovyMemory = /^(true|yes|1)$/i.test(value);
        break;
      case "default_type": {
        const t = MEMORY_TYPES.find((x) => x === value);
        if (t) meta.defaultType = t;
        break;
      }
      case "default_importance": {
        const n = Number(value);
        if (Number.isFinite(n)) meta.defaultImportance = clampImportance(n);
        break;
      }
      default:
        meta.extras[key] = value;
    }
  }

  const body = lines.slice(close + 1).join("\n");
  return { meta, body, bodyLineOffset: close + 1 };
}

// ---------------------------------------------------------------------------
// Bullet matcher
// ---------------------------------------------------------------------------

/** `- type(importance): content` — full form. */
const BULLET_FULL = /^\s*[-*]\s+([a-z]+)\s*\(\s*(\d{1,3})\s*\)\s*:\s*(.*)$/;

/** `- type: content` — type only. */
const BULLET_TYPED = /^\s*[-*]\s+([a-z]+)\s*:\s*(.*)$/;

/** `- content` — bare bullet. */
const BULLET_BARE = /^\s*[-*]\s+(.+)$/;

/** Section heading. */
const HEADING = /^\s*##+\s+(.+?)\s*$/;

/**
 * Match a bullet line against the three shapes. Returns the destructured
 * record fragment or null if the line is not a bullet.
 *
 * The "type" capture only counts as a real type if it's in `MEMORY_TYPES` —
 * otherwise we fall back to the bare-bullet path so `- not-a-type: foo` is
 * preserved verbatim instead of silently dropping the prefix.
 */
function matchBullet(line: string, defaults: FrontmatterMeta): {
  type: MemoryType;
  importance: number;
  content: string;
} | null {
  let m = BULLET_FULL.exec(line);
  if (m) {
    const cand = (m[1] ?? "") as MemoryType;
    if (MEMORY_TYPES.includes(cand)) {
      const imp = clampImportance(Number(m[2] ?? defaults.defaultImportance));
      return { type: cand, importance: imp, content: (m[3] ?? "").trim() };
    }
  }
  m = BULLET_TYPED.exec(line);
  if (m) {
    const cand = (m[1] ?? "") as MemoryType;
    if (MEMORY_TYPES.includes(cand)) {
      return {
        type: cand,
        importance: defaults.defaultImportance,
        content: (m[2] ?? "").trim(),
      };
    }
  }
  m = BULLET_BARE.exec(line);
  if (m) {
    return {
      type: defaults.defaultType,
      importance: FALLBACK_IMPORTANCE,
      content: (m[1] ?? "").trim(),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

/**
 * Parse a MEMORY.md / notes.md / progress.md document into records.
 *
 * `defaultLayer` decides how unparsed prose is filed (the parser itself
 * doesn't return layer — that's a property of the source file, set by the
 * calling sync routine). `parse()` is layer-agnostic on purpose so the
 * same code path works for all four file types.
 */
export function parseMemoryDocument(raw: string): ParseResult {
  const { meta, body, bodyLineOffset } = stripFrontmatter(raw);
  const records: ParsedMemory[] = [];

  const lines = body.split(/\r?\n/);
  let currentSection: string | null = null;
  let i = 0;
  let pendingProse: { startLine: number; lines: string[] } | null = null;

  const flushProse = (): void => {
    if (!pendingProse) return;
    const text = pendingProse.lines.join("\n").trim();
    if (text.length > 0) {
      records.push({
        type: meta.defaultType,
        importance: FALLBACK_IMPORTANCE,
        content: text,
        sourceLine: bodyLineOffset + pendingProse.startLine + 1,
        tags: currentSection ? [currentSection] : [],
      });
    }
    pendingProse = null;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Section heading → reset section, flush pending prose.
    const h = HEADING.exec(line);
    if (h) {
      flushProse();
      currentSection = (h[1] ?? "").toLowerCase().trim();
      i++;
      continue;
    }

    // Blank line → section separator within the current heading; flush prose.
    if (line.trim().length === 0) {
      flushProse();
      i++;
      continue;
    }

    // Bullet?
    const bullet = matchBullet(line, meta);
    if (bullet) {
      flushProse();
      // Fold continuation lines (indented further than the bullet's `-`).
      const startLine = i;
      let content = bullet.content;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        if (next.trim().length === 0) break;
        if (HEADING.test(next)) break;
        if (/^\s*[-*]\s/.test(next)) break;
        content += " " + next.trim();
        j++;
      }
      records.push({
        type: bullet.type,
        importance: bullet.importance,
        content: content.trim(),
        sourceLine: bodyLineOffset + startLine + 1,
        tags: currentSection ? [currentSection] : [],
      });
      i = j;
      continue;
    }

    // Plain prose — accumulate; will be filed as a single fallback record on
    // the next blank line / heading / bullet.
    if (!pendingProse) pendingProse = { startLine: i, lines: [] };
    pendingProse.lines.push(line);
    i++;
  }
  flushProse();

  return { meta, records, managed: meta.chovyMemory };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp importance to [0, 100], rounding non-integers. NaN → DEFAULT. */
export function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_IMPORTANCE;
  const i = Math.round(n);
  if (i < 0) return 0;
  if (i > 100) return 100;
  return i;
}

/** Layer hint helper — file path → `MemoryLayer`. */
export function inferLayerFromPath(p: string): MemoryLayer {
  const lower = p.replace(/\\/g, "/").toLowerCase();
  if (lower.endsWith("/memory.md") || lower.endsWith("memory.md")) return "project";
  if (lower.includes("/checkpoints/")) return "checkpoint";
  if (lower.endsWith("/notes.md") || lower.endsWith("notes.md")) return "notes";
  if (lower.includes("/tasks/") && lower.endsWith("progress.md")) return "progress";
  // Default to project for unknown paths under MEMORY.md vicinity.
  return "project";
}
