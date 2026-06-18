/**
 * step-12 permission engine smoke test.
 *
 * Verifies the 4 acceptance criteria from `docs/step-12-permission-engine.md`:
 *   1. default mode: Read/Grep/Glob allow; Edit asks; `rm -rf` denies.
 *   2. plan mode: any mutating tool denies.
 *   3. bypassPermissions: `.gitconfig` modification still denied.
 *   4. 3 consecutive ask-denials in `auto` downgrade to `default`.
 *
 * Plus the L1/L4 ordering risk (plan+acceptEdits don't cross-talk).
 *
 * Runs against the REAL registered tools (so preflight behavior is
 * exercised) but constructs a synthetic ToolContext + fresh engine state per
 * case so there's no global leakage. Run: `bun run scripts/smoke-step12.ts`.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import "../src/tools/index.js"; // registers built-in tools
import { getTool } from "../src/tools/index.js";
import { logger } from "../src/logger/index.js";
import { loadConfig } from "../src/config/index.js";
import { projectId as deriveProjectId } from "../src/fs/paths.js";
import type { Tool, ToolContext } from "../src/types/index.js";
import {
  createPermissionEngineState,
  hasPermission,
  parseRuleString,
  type PermissionEngineState,
} from "../src/harness/permissions/index.js";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function makeCtx(opts: { interactive?: boolean } = {}): ToolContext {
  const cwd = process.cwd();
  const interactive = opts.interactive ?? false;
  return {
    cwd,
    abortSignal: new AbortController().signal,
    logger,
    permissions: {},
    hooks: {},
    config: loadConfig(),
    sessionId: "smoke-step12",
    projectId: deriveProjectId(cwd),
    session: { todoList: [] },
    isInteractive: () => interactive,
    // askUser intentionally absent → ask outcomes deny in non-interactive.
  };
}

function makeState(
  mode: PermissionEngineState["mode"],
  rules: { allow?: string[]; ask?: string[]; deny?: string[] } = {},
): PermissionEngineState {
  const parsed = {
    allow: (rules.allow ?? []).map((s) => parseRuleString(s, "allow")),
    ask: (rules.ask ?? []).map((s) => parseRuleString(s, "ask")),
    deny: (rules.deny ?? []).map((s) => parseRuleString(s, "deny")),
  };
  return createPermissionEngineState({
    mode,
    cwd: process.cwd(),
    dontAsk: true, // smoke runs non-interactively → ask should deny
    rules: parsed,
  });
}

async function dec(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  state: PermissionEngineState,
) {
  return hasPermission(tool, args, ctx, state);
}

async function main() {
  const ctx = makeCtx({ interactive: false });
  const fileRead = getTool("file_read")!;
  const grep = getTool("grep")!;
  const glob = getTool("glob")!;
  const fileEdit = getTool("file_edit")!;
  const fileWrite = getTool("file_write")!;
  const bash = getTool("bash")!;

  // ── 1. default mode ────────────────────────────────────────────────────
  console.log("\n[1] default mode");
  {
    const st = makeState("default");
    const r = await dec(fileRead, { path: "/tmp/notes.md" }, ctx, st);
    check("file_read allows in default", r.outcome === "allow", r.reason);
  }
  {
    const st = makeState("default");
    const r = await dec(grep, { pattern: "x", path: "/tmp" }, ctx, st);
    check("grep allows in default", r.outcome === "allow", r.reason);
  }
  {
    const st = makeState("default");
    const r = await dec(glob, { pattern: "*.ts", path: "/tmp" }, ctx, st);
    check("glob allows in default", r.outcome === "allow", r.reason);
  }
  {
    // file_edit requires a prior read; without one its preflight denies.
    const st = makeState("default");
    const r = await dec(fileEdit, { path: "/tmp/x.md", oldString: "a", newString: "b" }, ctx, st);
    check("file_edit denied/asked in default (no prior read)", r.outcome === "deny" || r.outcome === "ask", r.reason);
  }
  {
    // rm -rf / → bash preflight hard-denies (L1c).
    const st = makeState("default");
    const r = await dec(bash, { command: "rm -rf /" }, ctx, st);
    check("rm -rf / denied in default", r.outcome === "deny", r.reason);
  }

  // ── 2. plan mode ───────────────────────────────────────────────────────
  console.log("\n[2] plan mode");
  {
    const st = makeState("plan");
    const r = await dec(fileWrite, { path: "/tmp/x.md", content: "hi" }, ctx, st);
    check("file_write denied in plan", r.outcome === "deny", r.reason);
  }
  {
    const st = makeState("plan");
    const r = await dec(fileEdit, { path: "/tmp/x.md", oldString: "a", newString: "b" }, ctx, st);
    check("file_edit denied in plan", r.outcome === "deny", r.reason);
  }
  {
    const st = makeState("plan");
    const r = await dec(bash, { command: "echo hi" }, ctx, st);
    check("bash denied in plan", r.outcome === "deny", r.reason);
  }
  {
    // read-only tools still allowed in plan.
    const st = makeState("plan");
    const r = await dec(fileRead, { path: "/tmp/notes.md" }, ctx, st);
    check("file_read still allowed in plan", r.outcome === "allow", r.reason);
  }

  // ── 3. bypassPermissions still denies .gitconfig ───────────────────────
  console.log("\n[3] bypassPermissions + .gitconfig");
  {
    const st = makeState("bypassPermissions");
    const gitconfig = join(homedir(), ".gitconfig");
    const r = await dec(fileWrite, { path: gitconfig, content: "x" }, ctx, st);
    check(".gitconfig write denied in bypass", r.outcome === "deny", r.reason);
  }
  {
    const st = makeState("bypassPermissions");
    const r = await dec(fileWrite, { path: "/tmp/normal.md", content: "x" }, ctx, st);
    check("normal write allowed in bypass", r.outcome === "allow", r.reason);
  }
  {
    // git --no-verify denied even in bypass.
    const st = makeState("bypassPermissions");
    const r = await dec(bash, { command: "git commit --no-verify" }, ctx, st);
    check("git --no-verify denied in bypass", r.outcome === "deny", r.reason);
  }

  // ── 4. auto downgrade after 3 denials ──────────────────────────────────
  console.log("\n[4] auto → default after 3 denials");
  {
    const st = makeState("auto");
    // auto allows safe tools; we need denials. A mutating tool (file_write)
    // in auto with dontAsk → deny. Three of those trip the breaker.
    for (let i = 0; i < 3; i++) {
      await dec(fileWrite, { path: "/tmp/deny.md", content: "x" }, ctx, st);
    }
    check("auto downgraded after 3 denials", st.autoDowngraded === true, `autoDowngraded=${st.autoDowngraded}`);
  }
  {
    // A fresh auto state where safe tools keep succeeding should NOT trip.
    const st = makeState("auto");
    for (let i = 0; i < 5; i++) {
      await dec(fileRead, { path: "/tmp/notes.md" }, ctx, st);
    }
    check("auto NOT downgraded on successes", st.autoDowngraded === false, `autoDowngraded=${st.autoDowngraded}`);
  }

  // ── L1/L4 ordering: plan + acceptEdits don't cross-talk ────────────────
  console.log("\n[5] L1/L4 ordering (plan vs acceptEdits)");
  {
    // acceptEdits allows file_write; plan does not. Same rules, different mode.
    const stAE = makeState("acceptEdits");
    const rAE = await dec(fileWrite, { path: "/tmp/ae.md", content: "x" }, ctx, stAE);
    check("file_write allowed in acceptEdits", rAE.outcome === "allow", rAE.reason);

    const stPlan = makeState("plan");
    const rPlan = await dec(fileWrite, { path: "/tmp/plan.md", content: "x" }, ctx, stPlan);
    check("file_write denied in plan (not influenced by acceptEdits logic)", rPlan.outcome === "deny", rPlan.reason);
  }
  {
    // deny rule beats acceptEdits allow.
    const st = makeState("acceptEdits", { deny: ["file_write"] });
    const r = await dec(fileWrite, { path: "/tmp/rule.md", content: "x" }, ctx, st);
    check("deny rule beats acceptEdits", r.outcome === "deny", r.reason);
  }

  // ── rules.json matching syntax ─────────────────────────────────────────
  console.log("\n[6] rule matching");
  {
    const st = makeState("default", { allow: ["bash(npm test:*)"] });
    const r = await dec(bash, { command: "npm test --foo" }, ctx, st);
    check("prefix rule bash(npm test:*) allows 'npm test --foo'", r.outcome === "allow", r.reason);
  }
  {
    const st = makeState("default", { allow: ["bash(npm test:*)"] });
    const r = await dec(bash, { command: "npm install" }, ctx, st);
    check("prefix rule does NOT allow 'npm install'", r.outcome !== "allow", r.reason);
  }
  {
    const st = makeState("default", { deny: ["bash(rm -rf:*)"] });
    const r = await dec(bash, { command: "rm -rf /tmp/junk" }, ctx, st);
    check("deny rule bash(rm -rf:*) denies 'rm -rf /tmp/junk'", r.outcome === "deny", r.reason);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
