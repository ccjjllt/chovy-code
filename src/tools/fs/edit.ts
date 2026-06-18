/**
 * `file_edit` — Tool Protocol v2 surgical string replacement (step-08).
 *
 * Models the cc-haha / Claude Code "exact-match Edit" tool: replace
 * `oldString` with `newString`. Two correctness guards lifted from
 * cc-haha's FileEditTool:
 *
 *   1. **Blind-write guard** — the file MUST have been read in this
 *      process (via `file_read`) before `file_edit` is allowed. Otherwise
 *      the model is patching a file it has not seen and will frequently
 *      generate a stale diff. This rule is described in
 *      `docs/step-08-fs-tools.md` ("必须是已经被 Read 过的文件").
 *
 *   2. **Unique-match invariant** — when `replaceAll` is false, `oldString`
 *      MUST appear exactly once. Zero matches → no-op error; multiple
 *      matches → ambiguity error that asks the model to disambiguate or
 *      pass `replaceAll: true`.
 *
 * Atomicity rides on `safeFs.write`'s tmp-file rename, the same as
 * `file_write`. The change is recorded in `fileHistory` so the cost-tracker
 * (step-16) can compute +/- lines.
 *
 * Permission preflight returns `ask` — `file_edit` is never auto-approved
 * (even for files the harness "owns"); plan mode will deny.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";

import { safeFs } from "../../fs/index.js";
import { logger } from "../../logger/index.js";
import { ChovyError } from "../../types/errors.js";
import type { Tool, ToolResult } from "../../types/index.js";
import { lineDelta, recordChange, wasRead } from "./fileHistory.js";

const argsSchema = z.object({
  path: z.string().describe("Absolute path of the file to edit."),
  oldString: z
    .string()
    .min(1)
    .describe(
      "Exact substring to replace. Must appear once in the file (or pass `replaceAll`).",
    ),
  newString: z.string().describe("Replacement substring (may be empty to delete)."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
});

type Args = z.infer<typeof argsSchema>;

/** Count non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Replace every non-overlapping occurrence of `needle` with `replacement`. */
function replaceAllExact(hay: string, needle: string, replacement: string): string {
  if (needle.length === 0) return hay;
  // String.prototype.replaceAll exists in modern runtimes (Bun + Node 16+),
  // but it interprets a string needle literally — perfect for our use.
  return hay.split(needle).join(replacement);
}

export const fileEditTool: Tool<typeof argsSchema> = {
  name: "file_edit",
  version: 2,
  family: "fs",
  isReadOnly: false,
  canUseWithoutAsk: false,

  desc: {
    lean: "Replace exact substring in a file (unique-match enforced).",
    full:
      "Surgical string-level edit at `path`.\n\n" +
      "- `path` MUST be absolute and MUST have been read this session via\n" +
      "  `file_read` first (blind-write guard).\n" +
      "- `oldString` is matched literally (no regex). When `replaceAll` is\n" +
      "  not set, `oldString` MUST occur exactly once in the file; zero or\n" +
      "  multiple matches return an explanatory error.\n" +
      "- `newString` may be empty (deletion). The file is rewritten\n" +
      "  atomically through `safeFs.write`.\n" +
      "- Blocked in `plan` mode by the permission engine (step-12).",
    examples: [
      `file_edit({ path: "/abs/foo.ts", oldString: "const x = 1", newString: "const x = 2" })`,
      `file_edit({ path: "/abs/foo.md", oldString: "TODO", newString: "DONE", replaceAll: true })`,
    ],
  },

  schema: argsSchema,

  userFacingName(args) {
    return `Edit ${args.path}`;
  },

  async checkPermissions(args) {
    if (!isAbsolute(args.path)) {
      return { outcome: "deny", reason: "path must be absolute" };
    }
    if (!wasRead(args.path)) {
      return {
        outcome: "deny",
        reason: "file_edit requires a prior file_read in this session",
      };
    }
    return { outcome: "ask", reason: "edit existing file" };
    // TODO step-12: defer to the 6-layer engine; plan mode will deny here.
  },

  async run(args: Args): Promise<ToolResult> {
    const t0 = Date.now();
    const { path, oldString, newString, replaceAll = false } = args;

    if (!isAbsolute(path)) {
      return {
        ok: false,
        content: `Error: \`path\` must be absolute (got: ${path}).`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    if (!wasRead(path)) {
      return {
        ok: false,
        content:
          "Error: file has not been read in this session. " +
          "Call `file_read` on this path before editing — the blind-write " +
          "guard rejects edits to unobserved files.",
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }

    if (oldString === newString) {
      return {
        ok: false,
        content: "Error: `oldString` and `newString` are identical (no-op).",
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    let before: string;
    try {
      before = await safeFs.read(path);
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

    const matches = countOccurrences(before, oldString);
    if (matches === 0) {
      return {
        ok: false,
        content:
          `Error: \`oldString\` not found in ${path}. ` +
          "Re-read the file and verify the exact substring (whitespace " +
          "and indentation must match byte-for-byte).",
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }
    if (!replaceAll && matches > 1) {
      return {
        ok: false,
        content:
          `Error: \`oldString\` matches ${matches} times in ${path}. ` +
          "Provide a longer / more unique substring, or set `replaceAll: true` " +
          "to replace every occurrence.",
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    const after = replaceAll
      ? replaceAllExact(before, oldString, newString)
      : before.replace(oldString, newString);

    if (after === before) {
      // Defensive — should be unreachable given the checks above.
      logger.debug("file_edit produced no change despite match", { path });
      return {
        ok: false,
        content: "Error: replacement produced no change.",
        errorCode: "INTERNAL",
        meta: { durMs: Date.now() - t0 },
      };
    }

    try {
      await safeFs.write(path, after);
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

    const replacedCount = replaceAll ? matches : 1;
    const delta = lineDelta(before, after);
    recordChange(path, delta);

    const summary =
      `Edited ${path}\n` +
      `replaced: ${replacedCount} occurrence${replacedCount === 1 ? "" : "s"}\n` +
      `lines delta: ${delta >= 0 ? "+" : ""}${delta}\n` +
      `bytes: ${Buffer.byteLength(after, "utf8")} (was ${Buffer.byteLength(before, "utf8")})`;

    return {
      ok: true,
      content: summary,
      structuredOutput: {
        kind: "edit",
        path,
        replaced: replacedCount,
        linesDelta: delta,
      },
      meta: {
        filesChanged: [path],
        bytes: Buffer.byteLength(after, "utf8"),
        durMs: Date.now() - t0,
      },
    };
  },
};
