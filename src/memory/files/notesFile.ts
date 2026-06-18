/**
 * notes.md read/write helpers (step-24).
 *
 * notes.md is the AI-only scratchpad. Spec limits ≤ 500 lines. Unlike
 * MEMORY.md, the human typically doesn't co-edit; the AI uses notes.md as
 * a self-managed working memory between turns.
 */

import { safeFs } from "../../fs/safeFs.js";
import { notesFile } from "../../fs/paths.js";
import { logger } from "../../logger/index.js";

export const MAX_NOTES_LINES = 500;
export const MAX_NOTES_BYTES = 64_000;

export interface NotesFileRead {
  content: string;
  truncated: boolean;
  lineCount: number;
  byteCount: number;
  path: string;
  existed: boolean;
}

export async function readNotesFile(cwd: string): Promise<NotesFileRead> {
  const path = notesFile(cwd);
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
  const raw = (await safeFs.read(path)).replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  const lineCount = lines.length;
  const byteCount = raw.length;
  if (lineCount <= MAX_NOTES_LINES && byteCount <= MAX_NOTES_BYTES) {
    return { content: raw, truncated: false, lineCount, byteCount, path, existed: true };
  }
  let body = lineCount > MAX_NOTES_LINES ? lines.slice(0, MAX_NOTES_LINES).join("\n") : raw;
  if (body.length > MAX_NOTES_BYTES) {
    const cut = body.lastIndexOf("\n", MAX_NOTES_BYTES);
    body = body.slice(0, cut > 0 ? cut : MAX_NOTES_BYTES);
  }
  logger.warn(`notesFile: truncated ${path}`, { lineCount, byteCount });
  return {
    content: body + `\n\n> WARNING: notes.md exceeded its size cap; tail dropped.`,
    truncated: true,
    lineCount,
    byteCount,
    path,
    existed: true,
  };
}

export async function writeNotesFile(cwd: string, content: string): Promise<void> {
  await safeFs.write(notesFile(cwd), content);
}

/** Append a single note (timestamped bullet). */
export async function appendNote(cwd: string, content: string): Promise<void> {
  const path = notesFile(cwd);
  const stamp = new Date().toISOString();
  await safeFs.append(path, `- [${stamp}] ${content.trim()}\n`);
}
