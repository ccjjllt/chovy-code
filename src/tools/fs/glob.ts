/**
 * `glob` — Tool Protocol v2 file-name pattern search (step-08).
 *
 * Wraps `new Bun.Glob(pattern).scan(...)` so the model can find files by
 * shape (`**\/*.ts`, `src\/*.test.tsx`, ...) without a shell. The behavior
 * is intentionally opinionated:
 *
 *   - Default `cwd` is `process.cwd()` (the harness working dir). Callers
 *     can pass an absolute `cwd` to scope the search elsewhere.
 *   - Results are absolute paths sorted by mtime (most-recently-modified
 *     first), matching cc-haha's GlobTool. Sorting fails open: if a
 *     `stat()` errors mid-collect we keep the entry with `mtime = 0`.
 *   - A built-in deny list filters out `node_modules`, `.git`, `dist`,
 *     `build`, and a few other "noise" directories. Pass `noIgnore: true`
 *     to disable it.
 *   - Hard cap of 200 results per call, surfaced via a `truncated` hint.
 *     The model can refine the pattern or call again with `cwd` deeper.
 *
 * `glob` is read-only and side-effect-free; permission preflight is
 * `allow`.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { z } from "zod";

import { logger } from "../../logger/index.js";
import type { Tool, ToolResult } from "../../types/index.js";

const RESULT_CAP = 200;

/** Substrings (path-segment-aware) that the default ignore filter drops. */
const DEFAULT_IGNORE_SEGMENTS = new Set<string>([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".chovy",
  "coverage",
  ".venv",
  "__pycache__",
]);

const argsSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.test.tsx").'),
  cwd: z
    .string()
    .optional()
    .describe(
      "Search root. Defaults to the harness working directory. Must be absolute when set.",
    ),
  noIgnore: z
    .boolean()
    .optional()
    .describe(
      "Disable the default ignore list (node_modules, .git, dist, ...). Off by default.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RESULT_CAP)
    .optional()
    .describe(`Max results to return (default and hard cap ${RESULT_CAP}).`),
});

type Args = z.infer<typeof argsSchema>;

/** True when any path segment of `rel` is in the deny set. */
function isIgnored(rel: string): boolean {
  // Bun.Glob emits forward slashes on every platform; split on both for
  // safety in case absolute joining slips a backslash through.
  const segs = rel.split(/[\\/]/);
  for (const s of segs) {
    if (DEFAULT_IGNORE_SEGMENTS.has(s)) return true;
  }
  return false;
}

export const globTool: Tool<typeof argsSchema> = {
  name: "glob",
  version: 2,
  family: "fs",
  isReadOnly: true,
  canUseWithoutAsk: true,

  desc: {
    lean: "Find files by glob pattern; returns paths sorted by mtime (newest first).",
    full:
      "Match filenames against a glob pattern using Bun's built-in matcher.\n\n" +
      '- `pattern` is a standard glob (e.g. `"**/*.ts"`, `"src/**/*.test.tsx"`).\n' +
      "- `cwd` defaults to the harness working directory. Pass an absolute path\n" +
      "  to scope deeper.\n" +
      `- Results are absolute paths, sorted by mtime descending, capped at ${RESULT_CAP}.\n` +
      "- A default ignore list drops `node_modules`, `.git`, `dist`, `build`,\n" +
      "  `.cache`, etc. Pass `noIgnore: true` to include them.\n" +
      "- Read-only; the permission engine fast-paths to allow.",
    examples: [
      `glob({ pattern: "**/*.tsx" })`,
      `glob({ pattern: "src/**/*.ts", cwd: "/abs/repo" })`,
    ],
  },

  schema: argsSchema,

  userFacingName(args) {
    return `Glob ${args.pattern}`;
  },

  checkPermissions() {
    return { outcome: "allow" };
  },

  async run(args: Args): Promise<ToolResult> {
    const t0 = Date.now();
    const cwd = args.cwd ?? process.cwd();

    if (!isAbsolute(cwd)) {
      return {
        ok: false,
        content: `Error: \`cwd\` must be absolute when set (got: ${cwd}).`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    const limit = args.limit ?? RESULT_CAP;
    const noIgnore = args.noIgnore === true;

    let scanner: AsyncIterable<string>;
    try {
      // Bun.Glob expects forward-slash patterns on every platform.
      const g = new Bun.Glob(args.pattern);
      scanner = g.scan({ cwd, onlyFiles: true, dot: false }) as AsyncIterable<string>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: `Error: invalid glob pattern — ${msg}`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    // Collect first (filtered, with cap awareness), then stat for sorting.
    const collected: string[] = [];
    let truncatedDuringScan = false;
    try {
      for await (const rel of scanner) {
        if (!noIgnore && isIgnored(rel)) continue;
        collected.push(rel);
        // We pull a slack of 4×limit so mtime sorting still has options to
        // pick from; the final slice trims to `limit`. Past 4×cap we stop —
        // returning *something* sensible beats churning on a 100k-file repo.
        if (collected.length >= limit * 4) {
          truncatedDuringScan = true;
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug("glob scan failed mid-stream", { pattern: args.pattern, error: msg });
      return {
        ok: false,
        content: `Error: glob scan failed — ${msg}`,
        errorCode: "MEMORY_IO",
        meta: { durMs: Date.now() - t0 },
      };
    }

    // mtime sort — newest first. `stat` failures degrade to mtime=0.
    const enriched = await Promise.all(
      collected.map(async (rel) => {
        const abs = isAbsolute(rel) ? rel : join(cwd, rel);
        try {
          const s = await stat(abs);
          return { abs, mtime: s.mtimeMs };
        } catch {
          return { abs, mtime: 0 };
        }
      }),
    );
    enriched.sort((a, b) => b.mtime - a.mtime);

    const total = enriched.length;
    const sliced = enriched.slice(0, limit);
    const truncated = truncatedDuringScan || total > limit;

    let body: string;
    if (sliced.length === 0) {
      body = `[no matches for ${args.pattern} under ${cwd}]`;
    } else {
      body = sliced.map((e) => e.abs).join("\n");
      if (truncated) {
        body +=
          `\n\n[... truncated: showing ${sliced.length} of ${total}${truncatedDuringScan ? "+" : ""}; ` +
          "refine the pattern or pass a deeper `cwd`.]";
      }
    }

    return {
      ok: true,
      content: body,
      structuredOutput: {
        kind: "glob",
        pattern: args.pattern,
        cwd,
        // Always emit forward-slash representation in `structuredOutput.cwdSep`
        // for any UI that wants to render breadcrumbs.
        cwdSep: sep,
        total,
        returned: sliced.length,
        truncated,
        paths: sliced.map((e) => e.abs),
      },
      meta: {
        durMs: Date.now() - t0,
      },
    };
  },
};
