/**
 * `file_write` — Tool Protocol v2 file write (step-08).
 *
 * Mutating tool. Atomically writes UTF-8 content to an absolute path. The
 * actual disk write goes through `safeFs.write`, which:
 *   - creates parent directories,
 *   - writes to a sibling `<name>.<pid>.<rand>.tmp` file, then renames
 *     onto the target (POSIX rename(2) / Windows MoveFileEx).
 *
 * Layered safety (only some land in this step):
 *   - Permission gate (step-12) — for now `checkPermissions` returns `ask`
 *     when overwriting, `allow` when creating; a TODO marks the step where
 *     the engine takes over.
 *   - Sandbox / cwd-allowlist (step-14) — `assertWritable` resolves
 *     symlinks and refuses writes to the dangerous-file blacklist
 *     (`.gitconfig`, `.ssh`, `.git/`, …) and to paths outside cwd
 *     without an explicit allow. Even `bypassPermissions` can't escape
 *     it (spec §与权限引擎的关系). `safeFs.remove` additionally refuses
 *     anything outside `~/.chovy`.
 *   - 1 MiB content cap — quick guardrail against the model dumping a
 *     pathological payload. Larger files should land via a streaming tool
 *     in a future step.
 *
 * Side effects:
 *   - Records the write in `fileHistory` (write count + line delta).
 *   - Returns `meta.filesChanged` so the cost-tracker (step-16) and the UI
 *     (step-22) can summarize what the agent actually changed.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";

import { safeFs } from "../../fs/index.js";
import { assertWritable } from "../../harness/sandbox/index.js";
import { logger } from "../../logger/index.js";
import { ChovyError } from "../../types/errors.js";
import type { Tool, ToolContext, ToolResult } from "../../types/index.js";
import { lineDelta, markRead, recordChange } from "./fileHistory.js";

const MAX_BYTES = 1024 * 1024; // 1 MiB

const argsSchema = z.object({
  path: z.string().describe("Absolute path of the file to write."),
  content: z
    .string()
    .describe("Full file contents to write (UTF-8). Will overwrite if the file exists."),
});

type Args = z.infer<typeof argsSchema>;

export const fileWriteTool: Tool<typeof argsSchema> = {
  name: "file_write",
  version: 2,
  family: "fs",
  isReadOnly: false,
  canUseWithoutAsk: false,

  desc: {
    lean: "Write a UTF-8 file at an absolute path (atomic; creates parents).",
    full:
      "Atomically write `content` to `path`.\n\n" +
      "- `path` MUST be absolute. Parent directories are created as needed.\n" +
      "- Existing files are overwritten without merging — pair with `file_read`\n" +
      "  first if the model wants to preserve any portion.\n" +
      `- Refuses payloads larger than ${MAX_BYTES} bytes (1 MiB).\n` +
      "- The write is atomic: a sibling tmp file is renamed onto the target,\n" +
      "  so concurrent readers never see a partial file.\n" +
      "- Mutating tool: blocked in `plan` mode by the permission engine\n" +
      "  (step-12). Today, `checkPermissions` returns `ask` for overwrites and\n" +
      "  `allow` for new files; the engine is consulted next.",
    examples: [
      `file_write({ path: "/abs/notes.md", content: "# Notes\\n" })`,
    ],
  },

  schema: argsSchema,

  userFacingName(args) {
    return `Write ${args.path}`;
  },

  async checkPermissions(args) {
    if (!isAbsolute(args.path)) {
      return {
        outcome: "deny",
        reason: "path must be absolute",
      };
    }
    const exists = await safeFs.exists(args.path);
    return exists
      ? { outcome: "ask", reason: "overwrite existing file" }
      : { outcome: "ask", reason: "create new file" };
    // TODO step-12: hand over to the 6-layer engine (mode + rules + hooks).
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    const { path, content } = args;

    if (!isAbsolute(path)) {
      return {
        ok: false,
        content: `Error: \`path\` must be absolute (got: ${path}).`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    // step-14 sandbox: physical write guard. Backstops the permission
    // engine's L1g safety check (which inspects only the literal path) by
    // resolving symlinks and refusing writes to the blacklist + outside
    // cwd. Even `bypassPermissions` can't escape this — the engine may
    // allow, but the tool refuses to write (spec §与权限引擎的关系).
    const sandbox = assertWritable(path, { cwd: ctx?.cwd ?? process.cwd() });
    if (!sandbox.ok) {
      return {
        ok: false,
        content: `Refused: ${sandbox.reason ?? "sandbox denied write"}`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) {
      return {
        ok: false,
        content:
          `Error: payload too large (${bytes} bytes > ${MAX_BYTES} cap). ` +
          "Split the write or use a streaming tool when one lands.",
        errorCode: "TOOL_INVALID_ARGS",
        meta: { bytes, durMs: Date.now() - t0 },
      };
    }

    // Diff against current file (if any) for a useful line delta. Read
    // failures here are non-fatal — we still go ahead with the write.
    let before = "";
    let existed = false;
    try {
      if (await safeFs.exists(path)) {
        before = await safeFs.read(path);
        existed = true;
      }
    } catch (err) {
      logger.debug("file_write: pre-read failed (continuing)", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await safeFs.write(path, content);
    } catch (err) {
      const code = err instanceof ChovyError ? err.code : "MEMORY_IO";
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: `Error: ${msg}`,
        errorCode: code,
        meta: { durMs: Date.now() - t0 },
      };
    }

    const delta = lineDelta(before, content);
    recordChange(path, delta);
    // The model just produced this content, so treat it as observed.
    markRead(path, bytes);

    const verb = existed ? "Overwrote" : "Created";
    const summary =
      `${verb} ${path}\n` +
      `bytes: ${bytes} (was ${Buffer.byteLength(before, "utf8")})\n` +
      `lines delta: ${delta >= 0 ? "+" : ""}${delta}`;

    return {
      ok: true,
      content: summary,
      structuredOutput: {
        kind: existed ? "overwrite" : "create",
        path,
        bytes,
        linesDelta: delta,
      },
      meta: {
        filesChanged: [path],
        bytes,
        durMs: Date.now() - t0,
      },
    };
  },
};
