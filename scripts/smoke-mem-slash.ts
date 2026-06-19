/**
 * Smoke for the `/mem` REPL slash command (step-24/25 wiring fix).
 *
 * Covers:
 *   - registration (entry present, not the old TODO stub)
 *   - no-runtime → friendly error, never throws
 *   - stub runtime → list/show/search/stats echo the runtime output
 *   - usage path (`/mem` with no subcommand)
 *   - unknown subcommand → usage
 *
 * The real store layer (createMemoryStore / FTS / sync) is covered by
 * `scripts/smoke-step24.ts` (50 checks). This file only exercises the
 * REPL slash wiring (`slashCommands/mem.ts` + `repl.tsx` injection).
 */

import { slashCommands, type ReplCtx, type ReplMemRuntime } from "../src/cli/slashCommands.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

function makeCtx(mem?: ReplMemRuntime): { ctx: ReplCtx; captured: string[] } {
  const captured: string[] = [];
  const ctx = {
    setMode() {},
    appendSystem(s: string) { captured.push(s); },
    clearMessages() {},
    toggleHelp() {},
    setGoal() {},
    exit() {},
    listProviders: () => [],
    listAgents: () => [],
    listSkills: () => [],
    mem,
  } as unknown as ReplCtx;
  return { ctx, captured };
}

// A stub runtime whose methods return canned, recognizable output.
function stubRuntime(): ReplMemRuntime {
  return {
    async list() {
      return [{ line: "mem_abc  project     decision    imp= 80  use bun" }];
    },
    async show(id) {
      if (id === "mem_missing") return { found: false };
      return { found: true, block: `layer      project\ntype       decision\n---\nuse bun` };
    },
    async search(_q) {
      return [{ line: "score=0.123 mem_abc  project/decision imp=80  use bun" }];
    },
    async stats() {
      return { block: "records   1\npath      /tmp/x.db\nprojectId pid\ndegraded  false" };
    },
  };
}

console.log("[1] registration");
{
  const entry = slashCommands["mem"];
  check("1a. /mem registered", entry !== undefined);
  check("1b. help not the old TODO text", !entry?.help.includes("TODO step-24/25"));
}

console.log("[2] no runtime → friendly error, never throws");
{
  const { ctx, captured } = makeCtx(undefined);
  let threw = false;
  try {
    await slashCommands["mem"]!.handler("list", ctx);
  } catch {
    threw = true;
  }
  check("2a. did not throw", !threw);
  check("2b. mentions runtime unavailable", captured.some((s) => s.includes("runtime unavailable")));
}

console.log("[3] /mem with no subcommand → usage");
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("", ctx);
  check("3a. shows usage block", captured.some((s) => s.includes("usage:") && s.includes("/mem list")));
}

console.log("[4] /mem list");
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("list", ctx);
  check("4a. echoes list header", captured.some((s) => s.includes("records:")));
  check("4b. echoes record line", captured.some((s) => s.includes("mem_abc")));
}

console.log("[5] /mem show <id>");
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("show mem_abc", ctx);
  check("5a. echoes show block", captured.some((s) => s.includes("use bun")));
}
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("show mem_missing", ctx);
  check("5b. not-found message", captured.some((s) => s.includes("not found")));
}
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("show", ctx);
  check("5c. missing id → usage hint", captured.some((s) => s.includes("usage: /mem show")));
}

console.log("[6] /mem search <query>");
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("search bun", ctx);
  check("6a. echoes matches header", captured.some((s) => s.includes("matches for \"bun\"")));
  check("6b. echoes scored line", captured.some((s) => s.includes("score=0.123")));
}
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("search", ctx);
  check("6c. empty query → usage hint", captured.some((s) => s.includes("usage: /mem search")));
}

console.log("[7] /mem stats");
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("stats", ctx);
  check("7a. echoes stats block", captured.some((s) => s.includes("records   1")));
}

console.log("[8] unknown subcommand → usage");
{
  const { ctx, captured } = makeCtx(stubRuntime());
  await slashCommands["mem"]!.handler("frobnicate", ctx);
  check("8a. mentions unknown subcommand", captured.some((s) => s.includes("unknown subcommand: frobnicate")));
}

console.log("[9] flag parsing (--layer / --limit)");
{
  // Stub that records what opts it received.
  const receivedOpts: { layer?: string; limit?: number } = {};
  const rt: ReplMemRuntime = {
    async list(opts) { Object.assign(receivedOpts, opts); return []; },
    async show() { return { found: false }; },
    async search() { return []; },
    async stats() { return { block: "" }; },
  };
  const { ctx } = makeCtx(rt);
  await slashCommands["mem"]!.handler("list --layer project --limit 5", ctx);
  check("9a. layer flag parsed", receivedOpts.layer === "project");
  check("9b. limit flag parsed", receivedOpts.limit === 5);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
