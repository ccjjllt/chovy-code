/**
 * `grep` — Tool Protocol v2 content search (step-08).
 *
 * Wraps ripgrep when available, falls back to a JS line-scanner when not.
 * The interface mirrors what cc-haha's GrepTool exposes (and what users
 * expect from `Grep` in the harness):
 *
 *   - `output_mode`:
 *       * `files_with_matches` (default) — paths only, one per line.
 *       * `content`                         — `path:line:body` matches,
 *         optionally with `-A/-B/-C` context.
 *       * `count`                           — `path:N` per file.
 *   - `pattern` is a regex (PCRE2 with rg, JS `RegExp` in fallback).
 *     `multiline: true` flips ripgrep into multiline mode and adds the
 *     `s` flag in the JS fallback.
 *   - `glob` filters which files to scan (Bun.Glob in the fallback;
 *     `rg --glob` upstream).
 *   - `type` is rg-only (e.g. `js`, `py`); the fallback ignores it with a
 *     debug log.
 *   - `path` defaults to the harness working dir; absolute-path required
 *     when explicit.
 *
 * Read-only; permission preflight is `allow`.
 *
 * Risk note (per `docs/step-08-fs-tools.md`): ripgrep is an external
 * binary. Detection is best-effort on first use and cached; absence
 * triggers a one-time `warn` log so operators see why fallback engaged.
 */

import { spawn as cpSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";

import { safeFs } from "../../fs/index.js";
import { logger } from "../../logger/index.js";
import type { Tool, ToolResult } from "../../types/index.js";

const RESULT_CAP = 200;

const argsSchema = z.object({
  pattern: z.string().min(1).describe("Regex to search for."),
  path: z
    .string()
    .optional()
    .describe("Absolute search root. Defaults to the harness working directory."),
  glob: z
    .string()
    .optional()
    .describe('Filter files by glob (e.g. "**/*.ts").'),
  type: z
    .string()
    .optional()
    .describe('rg file-type filter (e.g. "js", "py"). Ignored by the JS fallback.'),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .describe("Output style; defaults to `files_with_matches`."),
  caseInsensitive: z
    .boolean()
    .optional()
    .describe("Case-insensitive search (rg -i / JS `i` flag)."),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "Allow `.` to match newlines and patterns to span lines (rg --multiline / JS `s`).",
    ),
  before: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of context before each match (rg -B). Content mode only."),
  after: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of context after each match (rg -A). Content mode only."),
  context: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of context before+after (rg -C). Content mode only."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RESULT_CAP)
    .optional()
    .describe(`Hard cap on lines/files returned (default and max ${RESULT_CAP}).`),
});

type Args = z.infer<typeof argsSchema>;
type OutputMode = NonNullable<Args["output_mode"]>;

// ---------------------------------------------------------------------------
// ripgrep detection
// ---------------------------------------------------------------------------

let rgAvailable: boolean | undefined;

/** First-call probe; caches the result so we don't spawn `rg --version` twice. */
function detectRipgrep(): boolean {
  if (rgAvailable !== undefined) return rgAvailable;
  try {
    const r = Bun.spawnSync(["rg", "--version"]);
    rgAvailable = r.exitCode === 0;
  } catch {
    rgAvailable = false;
  }
  if (!rgAvailable) {
    logger.warn("ripgrep not found on PATH — `grep` tool falls back to JS line scan");
  }
  return rgAvailable;
}

/** Test-only: clear the cached probe result. */
export function _resetRipgrepProbeForTesting(): void {
  rgAvailable = undefined;
}

// ---------------------------------------------------------------------------
// ripgrep path
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  content: string;
  totalMatches: number;
  truncated: boolean;
  errorCode?: import("../../types/errors.js").ErrorCode;
}

function buildRgArgs(args: Args, mode: OutputMode, cwd: string): string[] {
  const out: string[] = ["--no-heading", "--color", "never"];
  // Mode flags.
  if (mode === "files_with_matches") out.push("--files-with-matches");
  else if (mode === "count") out.push("--count");
  else {
    out.push("--line-number", "--with-filename");
    if (args.context !== undefined) out.push("-C", String(args.context));
    if (args.before !== undefined) out.push("-B", String(args.before));
    if (args.after !== undefined) out.push("-A", String(args.after));
  }
  if (args.caseInsensitive) out.push("-i");
  if (args.multiline) {
    out.push("--multiline", "--multiline-dotall");
  }
  if (args.glob) out.push("--glob", args.glob);
  if (args.type) out.push("--type", args.type);
  out.push("--", args.pattern, cwd);
  return out;
}

function runRipgrep(args: Args, mode: OutputMode, cwd: string, limit: number): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = cpSpawn("rg", buildRgArgs(args, mode, cwd), {
      cwd,
      windowsHide: true,
      // We want stderr separately so we can attribute spawn / pattern errors.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (err) => {
      // ENOENT here means our cached probe lied (rg removed mid-run); fall
      // back caller will pick it up.
      logger.debug("rg spawn error", { error: err.message });
      rgAvailable = false;
      resolveP({
        ok: false,
        content: `Error: rg spawn failed — ${err.message}`,
        totalMatches: 0,
        truncated: false,
        errorCode: "INTERNAL",
      });
    });

    child.on("close", (code) => {
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) {
        resolveP({
          ok: false,
          content: `Error: rg failed — ${stderr.trim() || "exit 2"}`,
          totalMatches: 0,
          truncated: false,
          errorCode: "INTERNAL",
        });
        return;
      }
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      const total = lines.length;
      const truncated = total > limit;
      const slice = truncated ? lines.slice(0, limit) : lines;
      resolveP({
        ok: true,
        content: slice.join("\n"),
        totalMatches: total,
        truncated,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// JS fallback
// ---------------------------------------------------------------------------

function buildRegex(args: Args): RegExp | { error: string } {
  let flags = "g";
  if (args.caseInsensitive) flags += "i";
  if (args.multiline) flags += "s";
  try {
    return new RegExp(args.pattern, flags);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function listCandidateFiles(args: Args, cwd: string): Promise<string[]> {
  const pattern = args.glob ?? "**/*";
  try {
    const g = new Bun.Glob(pattern);
    const out: string[] = [];
    for await (const rel of g.scan({ cwd, onlyFiles: true, dot: false }) as AsyncIterable<string>) {
      // Skip the worst noise so the fallback doesn't read every node_modules file.
      if (
        rel.includes("node_modules") ||
        rel.startsWith(".git") ||
        rel.includes("/.git/") ||
        rel.includes("\\.git\\")
      ) {
        continue;
      }
      out.push(rel);
      // Defensive cap so we don't OOM on huge repos.
      if (out.length >= 50_000) break;
    }
    return out;
  } catch (err) {
    logger.debug("grep fallback: glob scan failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function runFallback(
  args: Args,
  mode: OutputMode,
  cwd: string,
  limit: number,
): Promise<RunResult> {
  if (args.type) {
    logger.debug("grep fallback ignores `type` (rg-only feature)", { type: args.type });
  }

  const reOrErr = buildRegex(args);
  if ("error" in reOrErr) {
    return {
      ok: false,
      content: `Error: invalid regex — ${reOrErr.error}`,
      totalMatches: 0,
      truncated: false,
      errorCode: "TOOL_INVALID_ARGS",
    };
  }
  const re = reOrErr;

  const files = await listCandidateFiles(args, cwd);
  // Skip absurdly large files (100 KiB cap is plenty for source code).
  const SCAN_FILE_CAP = 1024 * 1024;

  const ctxBefore = args.context ?? args.before ?? 0;
  const ctxAfter = args.context ?? args.after ?? 0;

  if (mode === "files_with_matches") {
    const hits: string[] = [];
    for (const rel of files) {
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      try {
        const s = await stat(abs);
        if (s.size > SCAN_FILE_CAP) continue;
        const body = await safeFs.read(abs);
        re.lastIndex = 0;
        if (re.test(body)) hits.push(abs);
        if (hits.length >= limit) break;
      } catch {
        // unreadable file — skip silently, matches rg behavior
      }
    }
    return {
      ok: true,
      content: hits.length === 0 ? "" : hits.join("\n"),
      totalMatches: hits.length,
      truncated: hits.length >= limit,
    };
  }

  if (mode === "count") {
    const lines: string[] = [];
    let total = 0;
    for (const rel of files) {
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      try {
        const s = await stat(abs);
        if (s.size > SCAN_FILE_CAP) continue;
        const body = await safeFs.read(abs);
        // Reset between files; `g` flag preserves lastIndex across calls.
        const matches = body.match(new RegExp(re.source, re.flags));
        const n = matches ? matches.length : 0;
        if (n > 0) {
          lines.push(`${abs}:${n}`);
          total += n;
          if (lines.length >= limit) break;
        }
      } catch {
        /* skip unreadable */
      }
    }
    return {
      ok: true,
      content: lines.join("\n"),
      totalMatches: total,
      truncated: lines.length >= limit,
    };
  }

  // content mode — emit `path:line:body` lines with optional context.
  const out: string[] = [];
  let totalMatches = 0;
  let hitCap = false;

  for (const rel of files) {
    if (hitCap) break;
    const abs = isAbsolute(rel) ? rel : join(cwd, rel);
    let body: string;
    try {
      const s = await stat(abs);
      if (s.size > SCAN_FILE_CAP) continue;
      body = await safeFs.read(abs);
    } catch {
      continue;
    }

    if (args.multiline) {
      // Multiline match: report each match on its own header line. Context
      // semantics on multiline patterns are fuzzy; we omit them.
      const fileRe = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = fileRe.exec(body)) !== null) {
        const lineNum = body.slice(0, m.index).split("\n").length;
        const firstLine = m[0].split("\n")[0] ?? m[0];
        out.push(`${abs}:${lineNum}:${firstLine}`);
        totalMatches += 1;
        if (out.length >= limit) {
          hitCap = true;
          break;
        }
        // Avoid zero-length match infinite loops.
        if (m.index === fileRe.lastIndex) fileRe.lastIndex += 1;
      }
      continue;
    }

    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineRe = new RegExp(re.source, re.flags.replace("g", ""));
      if (lineRe.test(lines[i] ?? "")) {
        // Emit context lines first.
        for (let c = Math.max(0, i - ctxBefore); c < i; c++) {
          out.push(`${abs}-${c + 1}-${lines[c] ?? ""}`);
        }
        out.push(`${abs}:${i + 1}:${lines[i] ?? ""}`);
        for (let c = i + 1; c <= Math.min(lines.length - 1, i + ctxAfter); c++) {
          out.push(`${abs}-${c + 1}-${lines[c] ?? ""}`);
        }
        totalMatches += 1;
        if (out.length >= limit) {
          hitCap = true;
          break;
        }
      }
    }
  }

  return {
    ok: true,
    content: out.join("\n"),
    totalMatches,
    truncated: hitCap,
  };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const grepTool: Tool<typeof argsSchema> = {
  name: "grep",
  version: 2,
  family: "fs",
  isReadOnly: true,
  canUseWithoutAsk: true,

  desc: {
    lean: "Search file contents by regex (ripgrep when available; JS fallback).",
    full:
      "Regex search across files. Wraps ripgrep when present; falls back to a\n" +
      "JS line-scanner so the tool always works.\n\n" +
      "- `output_mode` defaults to `files_with_matches`. Use `content` for\n" +
      "  `path:line:body` hits (with optional `-A/-B/-C` context), or `count`\n" +
      "  for a per-file total.\n" +
      "- `pattern` is PCRE2 under rg, JavaScript `RegExp` in the fallback.\n" +
      "- `multiline: true` lets `.` match newlines and patterns span lines.\n" +
      "- `glob` filters which files to scan; `type` (e.g. `js`, `py`) is rg-only.\n" +
      `- Hard cap of ${RESULT_CAP} result lines per call. Refine the pattern or\n` +
      "  pass `path` deeper if you hit it.",
    examples: [
      `grep({ pattern: "TODO" })`,
      `grep({ pattern: "function\\\\s+\\\\w+", glob: "**/*.ts", output_mode: "content", context: 2 })`,
      `grep({ pattern: "interface", output_mode: "count" })`,
    ],
  },

  schema: argsSchema,

  userFacingName(args) {
    return `Grep ${args.pattern}`;
  },

  checkPermissions() {
    return { outcome: "allow" };
  },

  async run(args: Args): Promise<ToolResult> {
    const t0 = Date.now();
    const cwd = args.path ?? process.cwd();

    if (args.path && !isAbsolute(args.path)) {
      return {
        ok: false,
        content: `Error: \`path\` must be absolute when set (got: ${args.path}).`,
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    const mode: OutputMode = args.output_mode ?? "files_with_matches";
    const limit = args.limit ?? RESULT_CAP;

    const useRg = detectRipgrep();
    const result = useRg
      ? await runRipgrep(args, mode, cwd, limit)
      : await runFallback(args, mode, cwd, limit);

    if (!result.ok) {
      return {
        ok: false,
        content: result.content,
        errorCode: result.errorCode ?? "INTERNAL",
        meta: { durMs: Date.now() - t0 },
      };
    }

    let body = result.content;
    if (body.length === 0) {
      body = `[no matches for /${args.pattern}/ under ${cwd}]`;
    } else if (result.truncated) {
      body +=
        `\n\n[... truncated at ${limit} ${mode === "files_with_matches" ? "files" : "lines"}; ` +
        "refine the pattern, narrow `glob`, or pass `path` deeper.]";
    }

    // For UI summaries: prefer a project-relative cwd hint when available.
    let cwdHint = cwd;
    try {
      const r = relative(process.cwd(), cwd);
      if (r && !r.startsWith("..")) cwdHint = r || ".";
    } catch {
      /* keep absolute */
    }

    return {
      ok: true,
      content: body,
      structuredOutput: {
        kind: "grep",
        backend: useRg ? "ripgrep" : "js-fallback",
        mode,
        pattern: args.pattern,
        cwd: cwdHint,
        totalMatches: result.totalMatches,
        truncated: result.truncated,
      },
      meta: {
        durMs: Date.now() - t0,
      },
    };
  },
};
