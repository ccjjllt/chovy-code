/**
 * MEMORY.md read/write helpers (step-24).
 *
 * MEMORY.md is the *project-tier* memory file: human-editable, AI-readable,
 * stored at `~/.chovy/projects/<hash(cwd)>/MEMORY.md`. It's the only memory
 * source files where the human is intended as a co-author — notes.md /
 * progress.md / checkpoints/*.md are AI-managed.
 *
 * Spec limits (step-24 §文件大小限制 + cc-haha alignment):
 *   - ≤ MAX_LINES = 200 lines
 *   - ≤ MAX_BYTES = 25 KB
 * Over-limit reads return the *truncated* content + a warning marker so the
 * AI can surface the issue to the user instead of silently dropping content.
 */

import { safeFs } from "../../fs/safeFs.js";
import { memoryFile } from "../../fs/paths.js";
import { logger } from "../../logger/index.js";

export const MAX_MEMORY_LINES = 200;
export const MAX_MEMORY_BYTES = 25_000;

export interface MemoryFileRead {
  content: string;
  /** Was the read truncated by line OR byte cap? */
  truncated: boolean;
  /** Original line count (pre-truncation). */
  lineCount: number;
  /** Original byte count (pre-truncation). */
  byteCount: number;
  /** Path that was read (absolute). */
  path: string;
  /** True iff the file existed on disk (false → empty default). */
  existed: boolean;
}

/**
 * Read MEMORY.md for the given cwd. Returns an empty content string when the
 * file doesn't exist yet (so callers don't have to ENOENT-guard).
 */
export async function readMemoryFile(cwd: string): Promise<MemoryFileRead> {
  const path = memoryFile(cwd);
  const exists = await safeFs.exists(path);
  if (!exists) {
    return {
      content: "",
      truncated: false,
      lineCount: 0,
      byteCount: 0,
      path,
      existed: false,
    };
  }
  const raw = await safeFs.read(path);
  return truncate(raw, path, true);
}

/** Atomic overwrite — uses `safeFs.write` (tmp + rename). */
export async function writeMemoryFile(cwd: string, content: string): Promise<void> {
  const path = memoryFile(cwd);
  await safeFs.write(path, content);
}

/**
 * Append a typed bullet line in the given section. If the section header
 * doesn't exist, it's created at the bottom of the file. The file is
 * truncated at write-time if it would exceed limits — we keep the *head*
 * (where frontmatter and section markers live) and drop tail bullets.
 */
export async function appendMemoryEntry(
  cwd: string,
  args: {
    section: string;
    type: string;
    importance: number;
    content: string;
  },
): Promise<void> {
  const existing = await readMemoryFile(cwd);
  const sectionHeader = `## ${args.section}`;
  const bullet = `- ${args.type}(${args.importance}): ${args.content}`;

  let body = existing.content;
  if (body.length > 0 && !body.endsWith("\n")) body += "\n";

  if (body.includes(sectionHeader)) {
    // Insert bullet at end of the section (next blank line after header).
    const lines = body.split(/\r?\n/);
    let inSection = false;
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === sectionHeader) {
        inSection = true;
        continue;
      }
      if (inSection && /^##+\s/.test(lines[i] ?? "")) {
        insertAt = i;
        break;
      }
    }
    if (inSection && insertAt === lines.length) insertAt = lines.length;
    lines.splice(insertAt, 0, bullet);
    body = lines.join("\n");
  } else {
    if (body.length > 0 && !body.endsWith("\n\n")) body += "\n";
    body += `${sectionHeader}\n\n${bullet}\n`;
  }

  // Pre-write truncation guard: if the new body exceeds caps, log and bail
  // rather than corrupting the existing file. Write tools should surface this
  // as an error to the user.
  if (body.length > MAX_MEMORY_BYTES) {
    logger.warn(
      `appendMemoryEntry: MEMORY.md would exceed ${MAX_MEMORY_BYTES} bytes; entry dropped`,
      { path: existing.path, attemptedBytes: body.length },
    );
    return;
  }
  if (body.split(/\r?\n/).length > MAX_MEMORY_LINES) {
    logger.warn(
      `appendMemoryEntry: MEMORY.md would exceed ${MAX_MEMORY_LINES} lines; entry dropped`,
      { path: existing.path },
    );
    return;
  }

  await writeMemoryFile(cwd, body);
}

// ---------------------------------------------------------------------------
// Truncation — exported for files/notesFile.ts to reuse when its own caller
// wants a similar shape.
// ---------------------------------------------------------------------------

export function truncate(
  raw: string,
  path: string,
  reportToLogger: boolean,
): MemoryFileRead {
  const trimmed = raw.replace(/^\uFEFF/, ""); // strip BOM if present
  const lines = trimmed.split(/\r?\n/);
  const lineCount = lines.length;
  const byteCount = trimmed.length;

  const overLines = lineCount > MAX_MEMORY_LINES;
  const overBytes = byteCount > MAX_MEMORY_BYTES;

  if (!overLines && !overBytes) {
    return { content: trimmed, truncated: false, lineCount, byteCount, path, existed: true };
  }

  // Line-truncate first (natural boundary), then byte-truncate at the last
  // newline before the byte cap. Same algorithm as cc-haha's
  // truncateEntrypointContent() — keeps human readers' instincts intact.
  let body = overLines ? lines.slice(0, MAX_MEMORY_LINES).join("\n") : trimmed;
  if (body.length > MAX_MEMORY_BYTES) {
    const cut = body.lastIndexOf("\n", MAX_MEMORY_BYTES);
    body = body.slice(0, cut > 0 ? cut : MAX_MEMORY_BYTES);
  }
  const reason =
    overBytes && !overLines
      ? `${byteCount} bytes (limit ${MAX_MEMORY_BYTES})`
      : overLines && !overBytes
        ? `${lineCount} lines (limit ${MAX_MEMORY_LINES})`
        : `${lineCount} lines and ${byteCount} bytes`;

  const warning = `\n\n> WARNING: ${path} is ${reason}. Only part of it was loaded. Move detail into topic files.`;
  if (reportToLogger) {
    logger.warn(`memoryFile: truncated ${path}`, { lineCount, byteCount });
  }
  return {
    content: body + warning,
    truncated: true,
    lineCount,
    byteCount,
    path,
    existed: true,
  };
}
