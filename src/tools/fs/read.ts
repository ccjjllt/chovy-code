/**
 * `file_read` — Tool Protocol v2 file read (step-08).
 *
 * Mirrors `cat -n` so the model can reference line numbers in subsequent
 * `file_edit` calls. Behavior is intentionally close to cc-haha's
 * FileReadTool / Claude Code's `Read` tool so users moving between agents
 * don't get surprised:
 *
 *   - `path` MUST be absolute. Relative paths return `TOOL_INVALID_ARGS`.
 *   - Default page size is 2000 lines. `offset` is 1-based; `limit`
 *     overrides the default.
 *   - Output line format: `   <N>\t<content>` (6-char right-aligned line
 *     number + tab). Lines are LF-normalized regardless of input.
 *   - When the file is truncated, an explanatory tail is appended so the
 *     model knows there's more (and which `offset` / `limit` to pass next).
 *   - Binary / image / PDF files: returns a stub message with size + mime
 *     hint instead of base64. The full base64 + image-attachment behavior
 *     is parked behind a `safeFs.readBytes` extension that step-04 owns
 *     (TODO step-04). Step-08 deliberately does NOT bypass safeFs.
 *
 * Side effects:
 *   - Marks the path in `fileHistory` so `file_edit` knows the model has
 *     observed it (the blind-write guard).
 *   - Emits `tool.call` telemetry via the agent-loop wrapper, plus a debug
 *     log line for diagnostics.
 */

import { extname, isAbsolute } from "node:path";
import { z } from "zod";

import { safeFs } from "../../fs/index.js";
import { logger } from "../../logger/index.js";
import { ChovyError } from "../../types/errors.js";
import type { Tool, ToolResult } from "../../types/index.js";
import { markRead } from "./fileHistory.js";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000; // hard cap so a single call can't drain a giant file
const LINE_NUM_WIDTH = 6;

/**
 * Extensions we detect as "non-text" today. Step-04 owns binary support;
 * step-08 just refuses politely so the model doesn't get garbage UTF-8.
 */
const BINARY_EXTS = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff",
  // documents
  ".pdf",
  // audio / video
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  // archives / binaries
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".exe", ".dll", ".so", ".dylib",
  ".class", ".jar", ".wasm",
]);

const argsSchema = z.object({
  path: z.string().describe("Absolute path to the file to read."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max lines to return (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`),
});

type Args = z.infer<typeof argsSchema>;

/** Right-align `n` to a fixed width with leading spaces. */
function padNum(n: number): string {
  const s = String(n);
  return s.length >= LINE_NUM_WIDTH ? s : " ".repeat(LINE_NUM_WIDTH - s.length) + s;
}

/** `cat -n`-style render. Numbers are 1-based starting at `firstLine`. */
function renderNumbered(lines: string[], firstLine: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(`${padNum(firstLine + i)}\t${lines[i] ?? ""}`);
  }
  return out.join("\n");
}

/** Split on LF after CRLF normalization. Trailing empty line is preserved. */
function splitLines(content: string): string[] {
  // Normalize CRLF / lone CR to LF so line numbers match what users see in
  // their editors. Tools that need to preserve original line endings should
  // re-read via `safeFs.read` directly.
  const normalized = content.replace(/\r\n?/g, "\n");
  return normalized.split("\n");
}

export const fileReadTool: Tool<typeof argsSchema> = {
  name: "file_read",
  version: 2,
  family: "fs",
  isReadOnly: true,
  canUseWithoutAsk: true,

  desc: {
    lean: "Read a file from disk; returns numbered lines (cat -n).",
    full:
      "Read a UTF-8 text file from the local filesystem.\n\n" +
      "- `path` MUST be absolute.\n" +
      `- Returns up to ${DEFAULT_LIMIT} lines per call. Pass \`offset\` (1-based) and \`limit\`\n` +
      "  to page through long files.\n" +
      "- Line format: 6-char right-aligned line number, tab, content. The model can\n" +
      "  reference these numbers when calling `file_edit`.\n" +
      "- Binary / image / PDF files return a stub with size + mime; full base64\n" +
      "  attachment support lands when safeFs grows a binary read API.\n" +
      "- Reading a file marks it as 'observed' so subsequent `file_edit` calls\n" +
      "  pass the blind-write guard.",
    examples: [
      `file_read({ path: "/abs/path/README.md" })`,
      `file_read({ path: "/abs/log.txt", offset: 1500, limit: 200 })`,
    ],
  },

  schema: argsSchema,

  userFacingName(args) {
    return `Read ${args.path}`;
  },

  // Read-only by family + explicit flag; the engine fast-paths to allow.
  checkPermissions() {
    return { outcome: "allow" };
  },

  async run(args: Args): Promise<ToolResult> {
    const t0 = Date.now();
    const { path } = args;

    if (!isAbsolute(path)) {
      return {
        ok: false,
        content: `Error: \`path\` must be absolute (got: ${path}).`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    const ext = extname(path).toLowerCase();
    if (BINARY_EXTS.has(ext)) {
      const stat = await safeFs.stat(path);
      if (!stat) {
        return {
          ok: false,
          content: `Error: file not found: ${path}`,
          errorCode: "MEMORY_IO",
          meta: { durMs: Date.now() - t0 },
        };
      }
      const msg =
        `[binary file: ${path}]\n` +
        `size: ${stat.size} bytes\n` +
        `ext: ${ext} (treated as binary; base64 attachment is a TODO step-04)`;
      return {
        ok: true,
        content: msg,
        structuredOutput: { kind: "binary", path, bytes: stat.size, ext },
        meta: { bytes: stat.size, durMs: Date.now() - t0 },
      };
    }

    let raw: string;
    try {
      raw = await safeFs.read(path);
    } catch (err) {
      const code = err instanceof ChovyError ? err.code : "MEMORY_IO";
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug("file_read failed", { path, error: msg });
      return {
        ok: false,
        content: `Error: ${msg}`,
        errorCode: code,
        meta: { durMs: Date.now() - t0 },
      };
    }

    const lines = splitLines(raw);
    // `splitLines` produces one extra empty element when the file ends with
    // `\n`. Strip that so line counts match `wc -l` for newline-terminated
    // files; otherwise keep the trailing partial line.
    const fileEndsWithNewline = raw.length > 0 && raw[raw.length - 1] === "\n";
    if (fileEndsWithNewline && lines[lines.length - 1] === "") lines.pop();

    const totalLines = lines.length;
    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.min(MAX_LIMIT, args.limit ?? DEFAULT_LIMIT);

    if (offset > totalLines && totalLines > 0) {
      return {
        ok: false,
        content:
          `Error: offset ${offset} is past EOF (file has ${totalLines} lines).`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { bytes: raw.length, durMs: Date.now() - t0 },
      };
    }

    const startIdx = offset - 1;
    const endIdx = Math.min(totalLines, startIdx + limit);
    const slice = lines.slice(startIdx, endIdx);
    const body = renderNumbered(slice, offset);

    let content = body;
    const truncated = endIdx < totalLines;
    if (truncated) {
      const remaining = totalLines - endIdx;
      content +=
        `\n\n[... truncated: showing lines ${offset}–${endIdx} of ${totalLines}; ` +
        `${remaining} more lines. Re-call with offset=${endIdx + 1} to continue.]`;
    } else if (totalLines === 0) {
      content = "[empty file]";
    }

    markRead(path, raw.length);

    return {
      ok: true,
      content,
      structuredOutput: {
        kind: "text",
        path,
        totalLines,
        offset,
        returned: slice.length,
        truncated,
      },
      meta: {
        bytes: raw.length,
        durMs: Date.now() - t0,
      },
    };
  },
};
