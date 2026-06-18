/**
 * Step-08 smoke harness — exercises file_read / file_write / file_edit /
 * glob / grep end-to-end without an LLM provider. The acceptance criteria
 * from `docs/step-08-fs-tools.md` are mapped to assertion blocks below.
 *
 * Run: `bun scripts/smoke-fs-tools.ts`
 * This file is throwaway / dev-only — not registered or imported by the
 * production CLI.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../src/tools/index.js";
import { getTool } from "../src/tools/index.js";
import { _resetFileHistoryForTesting } from "../src/tools/fs/index.js";
import { loadConfig } from "../src/config/index.js";
import { logger } from "../src/logger/index.js";
import { projectId as deriveProjectId } from "../src/fs/paths.js";
import type { ToolContext } from "../src/types/index.js";

function must(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  } else {
    console.log(`PASS: ${label}`);
  }
}

/**
 * Call a tool with a ToolContext whose `cwd` is the temp working dir.
 * step-14's `assertWritable` resolves writes against `ctx.cwd`, so the
 * smoke harness must pass a ctx matching the temp dir — mirroring how
 * the agent loop wires `ctx.cwd = process.cwd()` for real runs. Without
 * this, the sandbox would (correctly) refuse writes to the temp dir as
 * "outside cwd".
 */
async function call(
  name: string,
  args: unknown,
  cwd: string,
): Promise<{ ok: boolean; content: string }> {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const ctx: ToolContext = {
    cwd,
    abortSignal: new AbortController().signal,
    logger,
    permissions: {},
    hooks: {},
    config: loadConfig(),
    sessionId: "smoke-fs-tools",
    projectId: deriveProjectId(cwd),
    session: { todoList: [] },
    isInteractive: () => false,
  };
  const raw = await tool.run(args as never, ctx);
  if (typeof raw === "string") return { ok: true, content: raw };
  return { ok: raw.ok, content: raw.content };
}

async function main(): Promise<void> {
  _resetFileHistoryForTesting();
  const dir = mkdtempSync(join(tmpdir(), "chovy-fs-smoke-"));
  try {
    const f = join(dir, "hello.txt");

    // ── file_write ─────────────────────────────────────────────────────────
    const w1 = await call("file_write", { path: f, content: "line one\nline two\nline three\n" }, dir);
    must(w1.ok && w1.content.includes("Created"), "file_write creates a new file");

    // ── file_read ──────────────────────────────────────────────────────────
    const r1 = await call("file_read", { path: f }, dir);
    must(r1.ok && r1.content.includes("     1\tline one"), "file_read emits cat -n numbered lines");
    must(r1.content.includes("     3\tline three"), "file_read shows all 3 lines");

    // ── file_read: absolute-path enforcement ───────────────────────────────
    const rRel = await call("file_read", { path: "relative/path.txt" }, dir);
    must(!rRel.ok && rRel.content.includes("must be absolute"), "file_read rejects relative paths");

    // ── file_edit: unique match ────────────────────────────────────────────
    const e1 = await call("file_edit", { path: f, oldString: "line two", newString: "LINE TWO" }, dir);
    must(e1.ok && e1.content.includes("replaced: 1"), "file_edit replaces a unique match");
    const r2 = await call("file_read", { path: f }, dir);
    must(r2.content.includes("LINE TWO"), "file_edit took effect on disk");

    // ── file_edit: ambiguous match ─────────────────────────────────────────
    const eAmb = await call("file_edit", { path: f, oldString: "line", newString: "row" }, dir);
    must(
      !eAmb.ok && eAmb.content.includes("matches 2 times"),
      "file_edit rejects ambiguous matches without replaceAll",
    );

    // ── file_edit: replaceAll ──────────────────────────────────────────────
    const eAll = await call("file_edit", {
      path: f, oldString: "line", newString: "row", replaceAll: true,
    }, dir);
    must(eAll.ok && eAll.content.includes("replaced: 2"), "file_edit replaceAll replaces all occurrences");

    // ── file_edit: blind-write guard ───────────────────────────────────────
    _resetFileHistoryForTesting();
    const eBlind = await call("file_edit", { path: f, oldString: "row", newString: "X" }, dir);
    must(
      !eBlind.ok && eBlind.content.includes("blind-write guard"),
      "file_edit refuses edits to files that were not read first",
    );

    // ── glob ───────────────────────────────────────────────────────────────
    await call("file_write", { path: join(dir, "a.ts"), content: "export const A = 1;\n" }, dir);
    await call("file_write", { path: join(dir, "b.ts"), content: "export const B = 2;\n" }, dir);
    await call("file_write", { path: join(dir, "ignore.md"), content: "ignore me\n" }, dir);
    const g1 = await call("glob", { pattern: "*.ts", cwd: dir }, dir);
    must(g1.ok && g1.content.includes("a.ts") && g1.content.includes("b.ts"), "glob finds .ts files");
    must(!g1.content.includes("ignore.md"), "glob respects extension filter");

    // ── grep: files_with_matches ───────────────────────────────────────────
    const gm1 = await call("grep", { pattern: "export const", path: dir }, dir);
    must(
      gm1.ok && gm1.content.includes("a.ts") && gm1.content.includes("b.ts"),
      "grep files_with_matches finds files containing pattern",
    );

    // ── grep: content + context ────────────────────────────────────────────
    const gm2 = await call("grep", { pattern: "const A", path: dir, output_mode: "content" }, dir);
    must(gm2.ok && /a\.ts.*:1:.*const A/.test(gm2.content), "grep content emits path:line:body");

    // ── grep: count mode ───────────────────────────────────────────────────
    const gm3 = await call("grep", { pattern: "export", path: dir, output_mode: "count" }, dir);
    must(gm3.ok && /a\.ts:1/.test(gm3.content) && /b\.ts:1/.test(gm3.content), "grep count returns per-file totals");

    // ── grep: no-match graceful message ────────────────────────────────────
    const gm4 = await call("grep", { pattern: "definitelyNotInAnyFile", path: dir }, dir);
    must(gm4.ok && gm4.content.startsWith("[no matches"), "grep gracefully reports no matches");

    // ── file_write: oversized payload refused ──────────────────────────────
    const big = "x".repeat(1024 * 1024 + 1);
    const wBig = await call("file_write", { path: join(dir, "big.bin"), content: big }, dir);
    must(!wBig.ok && wBig.content.includes("payload too large"), "file_write refuses payloads > 1 MiB");

    console.log("\nAll smoke checks passed.");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error("SMOKE CRASH:", err);
  process.exit(1);
});
