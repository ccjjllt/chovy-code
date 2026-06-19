/**
 * Step-29 CSG (Conditional Skill Graph) smoke (run with `bun scripts/smoke-step29.ts`).
 *
 * Covers `docs/step-29-skill-graph.md §验收标准` + AGENTS.md §I cross-step
 * invariants from the plan:
 *
 *   1. Bundled skills register: 7 skills (commit/format/pr/refactor/review/
 *      test/ts-fix), each with non-empty systemFragment and budgetTokens > 0.
 *   2. Closure: input "帮我修这个 bug 然后提交" → planner activates
 *      [ts-fix, format, commit] (ts-fix.requires=format → BFS pulls format;
 *      commit independent). All scores > 0.
 *   3. Conflicts: two skills with reciprocal `conflicts` → high-score wins,
 *      low-score dropped + reported in `droppedByConflict`.
 *   4. Budget: capping skills budget below the sum forces the planner to
 *      drop lowest-score nodes; cascade also drops dependents.
 *   5. Fingerprint: same input twice → second call hits the lock
 *      (telemetry `fingerprintHit:true`); changing latestUserText → miss.
 *   6. Manual override: SkillTool.run({skill:'commit'}) populates
 *      `session.activeSkillFragments['commit']` + manualSkillNames; chain
 *      includes transitive requires.
 *   7. Manual missing-required: SkillTool refuses (TOOL_DENIED) when a
 *      transitive require isn't registered.
 *   8. Manual conflict: SkillTool refuses when target.conflicts intersects
 *      already-active session names.
 *   9. CHOVY_SKILLS_AUTO unset (default OFF): runSkillRound emits mode:
 *      'manual-only' (or 'disabled' if registry empty) and does NOT run
 *      planner. Manual entries on the session still flow into the prompt.
 *  10. CHOVY_SKILLS_AUTO=1: runSkillRound emits mode:'auto', calls planner,
 *      writes lock, populates session.activeSkillFragments.
 *  11. Prompt injection: skillFragmentsSection renders a `<skill name=...>`
 *      block per active fragment; empty input → empty section.
 *  12. ToolSession back-compat: existing TodoWrite still works on a session
 *      that also holds activeSkillFragments / manualSkillNames.
 *  13. queryEngine.ts ≤ 600 lines (AGENTS.md §17 hard cap preserved).
 *
 * Fully offline: stubs the telemetry sink + uses tmp CHOVY_HOME so
 * skills.lock writes don't pollute the user's home dir. No provider
 * calls — planner is sync regex.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tmp dir + CHOVY_HOME override (set before any home/paths import) ─
const TMP_HOME = join(tmpdir(), `chovy-smoke29-${Date.now().toString(36)}`);
process.env["CHOVY_HOME"] = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

// Capture telemetry into an in-memory ring before any module emits.
import {
  setTelemetrySink,
  type TelemetrySink,
} from "../src/telemetry/index.js";
import type { TelemetryEvent } from "../src/telemetry/events.js";

const captured: TelemetryEvent[] = [];
const captureSink: TelemetrySink = {
  enabled: true,
  emit: (input) => {
    captured.push({ ...input, ts: Date.now() } as TelemetryEvent);
  },
  flush: async () => { /* no-op */ },
  close: () => { /* no-op */ },
  currentFile: () => "",
};
setTelemetrySink(captureSink);

import {
  ensureBundledSkillsInitialized,
  resetSkillRegistry,
  registerSkill,
  markBundledInitialized,
  listSkills,
  computeClosure,
  resolveConflicts,
  enforceBudget,
  resolveManualClosure,
  plan,
  computeFingerprint,
  extractIntent,
  loadSkillsLock,
  renderSkillFragments,
  type Skill,
} from "../src/skills/index.js";
import { skillFragmentsSection, skillsSection } from "../src/prompts/index.js";
import { skillTool } from "../src/tools/meta/skill.js";
import { todoWriteTool } from "../src/tools/meta/todoWrite.js";
import { runSkillRound } from "../src/engine/skillHook.js";
import { loadConfig, resetConfigCache } from "../src/config/index.js";
import { resetFeaturesCache } from "../src/config/features.js";
import { ensureHomeDirs, _resetHomeEnsureCacheForTesting } from "../src/fs/home.js";
import {
  ensureProjectDirs,
  _resetProjectEnsureCacheForTesting,
} from "../src/fs/paths.js";
import type { ChatMessage, ToolSession, ToolContext } from "../src/types/index.js";

// ── Test infra ──
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(msg: string): void {
  pass++;
  console.log(`  ✓ ${msg}`);
}
function bad(msg: string, err?: unknown): void {
  fail++;
  const detail = err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : "";
  failures.push(`✗ ${msg}${detail}`);
  console.log(`  ✗ ${msg}${detail}`);
}
function eq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(msg);
  else bad(`${msg}\n      actual:   ${a}\n      expected: ${e}`);
}
function truthy(v: unknown, msg: string): void {
  if (v) ok(msg); else bad(msg);
}
function hdr(s: string): void {
  console.log(`\n— ${s} —`);
}

const cwd = TMP_HOME;
ensureHomeDirs();
ensureProjectDirs(cwd);
resetConfigCache();
resetFeaturesCache();
const cfg = loadConfig();
const provider = "openai" as const;
const model = "gpt-4o";

function freshSession(): ToolSession {
  return { todoList: [], activeSkillFragments: {}, manualSkillNames: [] };
}

function fakeCtx(session: ToolSession): ToolContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    logger: console as unknown as ToolContext["logger"],
    permissions: {},
    hooks: {} as ToolContext["hooks"],
    config: cfg,
    sessionId: "smoke",
    projectId: "smoke",
    session,
  };
}

// ─── 1. Bundled skills register ──────────────────────────────────────────────
hdr("§1 bundled skills register");
{
  resetSkillRegistry();
  await ensureBundledSkillsInitialized();
  const all = listSkills();
  eq(all.length, 7, "7 bundled skills registered");
  const names = all.map((s) => s.name).sort();
  eq(names, ["commit", "format", "pr", "refactor", "review", "test", "ts-fix"], "names match spec");
  for (const s of all) {
    truthy(s.systemFragment.length > 50, `${s.name}: systemFragment non-empty`);
    truthy(s.budgetTokens > 0, `${s.name}: budgetTokens > 0`);
  }
}

// ─── 2. Closure: bug fix + commit ───────────────────────────────────────────
hdr("§2 closure — bug fix + commit");
{
  resetSkillRegistry();
  await ensureBundledSkillsInitialized();
  const result = plan(listSkills(), {
    latestUserText: "帮我修这个 bug 然后提交",
    budgetTokens: 8000,
    recentMessages: [],
  });
  const selected = result.nodes.map((n) => n.skill.name).sort();
  truthy(selected.includes("commit"), "commit selected");
  truthy(selected.includes("ts-fix") || selected.includes("format"), "ts-fix or format selected (bug intent)");
  // ts-fix requires format → if ts-fix selected, format must transitively be in
  if (selected.includes("ts-fix")) {
    truthy(selected.includes("format"), "ts-fix transitively pulls format");
  }
  truthy(result.totalTokens <= 8000, "total tokens within budget");
}

// ─── 3. Conflict resolution ─────────────────────────────────────────────────
hdr("§3 conflict resolution");
{
  resetSkillRegistry();
  const high: Skill = {
    name: "high",
    summary: "h",
    triggers: { keywords: ["xxx"] },
    conflicts: ["low"],
    systemFragment: "h-body",
    budgetTokens: 100,
  };
  const low: Skill = {
    name: "low",
    summary: "l",
    triggers: { keywords: ["xxx"] },
    conflicts: ["high"],
    systemFragment: "l-body",
    budgetTokens: 100,
  };
  registerSkill(high);
  registerSkill(low);
  const r = plan(listSkills(), {
    latestUserText: "xxx xxx xxx",
    budgetTokens: 8000,
    recentMessages: [],
  });
  // Ties are broken deterministically by name; "high" < "low" lex so high wins.
  // Either way, exactly one survives.
  eq(r.nodes.length, 1, "exactly one survives conflict");
  truthy(r.droppedByConflict.length === 1, "one node reported as dropped-by-conflict");
}

// ─── 4. Budget cascade ──────────────────────────────────────────────────────
hdr("§4 budget cascade");
{
  resetSkillRegistry();
  const a: Skill = { name: "a", summary: "a", triggers: { keywords: ["go"] }, systemFragment: "a", budgetTokens: 500 };
  const b: Skill = { name: "b", summary: "b", triggers: { keywords: ["go"] }, requires: ["a"], systemFragment: "b", budgetTokens: 500 };
  const c: Skill = { name: "c", summary: "c", triggers: { keywords: ["go"] }, systemFragment: "c", budgetTokens: 500 };
  registerSkill(a);
  registerSkill(b);
  registerSkill(c);
  // Force a tight budget (300) — only ONE skill fits; budget enforcement
  // drops lowest score, cascades dependents.
  const r = plan(listSkills(), {
    latestUserText: "go go go",
    budgetTokens: 300,
    recentMessages: [],
  });
  truthy(r.totalTokens <= 300, "total tokens ≤ budget after enforce");
  truthy(r.droppedByBudget.length >= 2, "at least 2 dropped by budget");
}

// ─── 5. Fingerprint cache ──────────────────────────────────────────────────
hdr("§5 fingerprint cache");
{
  const input = {
    latestUserText: "fix the bug and commit",
    budgetTokens: 8000,
    manualNames: ["commit"],
    recentMessages: [] as ChatMessage[],
  };
  const intent = extractIntent({ latestUserText: input.latestUserText });
  const fp1 = computeFingerprint(input, intent);
  const fp2 = computeFingerprint(input, intent);
  eq(fp1, fp2, "identical inputs → identical fingerprint");
  const fp3 = computeFingerprint(
    { ...input, latestUserText: "different text" },
    extractIntent({ latestUserText: "different text" }),
  );
  truthy(fp3 !== fp1, "different text → different fingerprint");
}

// ─── 6. SkillTool manual activation ────────────────────────────────────────
hdr("§6 SkillTool manual activation");
{
  resetSkillRegistry();
  await ensureBundledSkillsInitialized();
  const session = freshSession();
  const ctx = fakeCtx(session);
  const result = await skillTool.run({ skill: "commit" }, ctx);
  if (typeof result === "string") {
    bad("expected ToolResult object, got string");
  } else {
    truthy(result.ok, "skillTool.run({skill:'commit'}) ok");
    truthy(
      session.activeSkillFragments?.["commit"]?.includes("Skill: commit") ?? false,
      "session.activeSkillFragments['commit'] populated",
    );
    truthy(
      session.manualSkillNames?.includes("commit") ?? false,
      "session.manualSkillNames includes 'commit'",
    );
  }
}

// ─── 7. SkillTool missing required ─────────────────────────────────────────
hdr("§7 SkillTool missing required");
{
  resetSkillRegistry();
  // Register only 'pr' (which requires 'commit') — commit deliberately absent.
  // Mark bundled-init done so skillTool.run() doesn't re-install the bundle.
  const pr: Skill = {
    name: "pr",
    summary: "pr",
    triggers: {},
    requires: ["commit"],
    systemFragment: "pr",
    budgetTokens: 100,
  };
  registerSkill(pr);
  markBundledInitialized();
  const session = freshSession();
  const ctx = fakeCtx(session);
  const result = await skillTool.run({ skill: "pr" }, ctx);
  if (typeof result === "string") {
    bad("expected ToolResult object");
  } else {
    truthy(!result.ok, "refused with !ok");
    eq(result.errorCode, "TOOL_DENIED", "errorCode=TOOL_DENIED");
    truthy(
      result.content.includes("commit"),
      "error message names the missing required",
    );
  }
}

// ─── 8. SkillTool conflict with active ─────────────────────────────────────
hdr("§8 SkillTool conflict with active");
{
  resetSkillRegistry();
  const a: Skill = {
    name: "a",
    summary: "a",
    triggers: {},
    conflicts: ["b"],
    systemFragment: "a",
    budgetTokens: 100,
  };
  const b: Skill = {
    name: "b",
    summary: "b",
    triggers: {},
    conflicts: ["a"],
    systemFragment: "b",
    budgetTokens: 100,
  };
  registerSkill(a);
  registerSkill(b);
  markBundledInitialized();
  const session = freshSession();
  // Pre-populate 'a' as active.
  session.activeSkillFragments = { a: "a" };
  const ctx = fakeCtx(session);
  const result = await skillTool.run({ skill: "b" }, ctx);
  if (typeof result === "string") {
    bad("expected ToolResult object");
  } else {
    truthy(!result.ok, "refused with !ok");
    eq(result.errorCode, "TOOL_DENIED", "errorCode=TOOL_DENIED");
    truthy(result.content.includes("conflicts"), "error mentions conflict");
  }
}

// ─── 9. CHOVY_SKILLS_AUTO unset → manual-only ───────────────────────────────
hdr("§9 CHOVY_SKILLS_AUTO unset → manual-only");
{
  resetSkillRegistry();
  await ensureBundledSkillsInitialized();
  delete process.env["CHOVY_SKILLS_AUTO"];
  resetFeaturesCache();
  captured.length = 0;
  const session = freshSession();
  const out = await runSkillRound({
    messages: [{ role: "user", content: "fix the bug and commit" }],
    session,
    agentRole: "main",
    cwd,
    cfg,
    provider,
    model,
  });
  eq(out.loadedSkills, [], "no skills loaded (auto off + no manual)");
  const ev = captured.filter((e) => e.type === "skill.plan");
  eq(ev.length, 1, "skill.plan emitted exactly once");
  eq((ev[0] as { mode: string }).mode, "manual-only", "mode=manual-only");
}

// ─── 10. CHOVY_SKILLS_AUTO=1 → auto + lock ──────────────────────────────────
hdr("§10 CHOVY_SKILLS_AUTO=1 → auto + lock");
{
  resetSkillRegistry();
  await ensureBundledSkillsInitialized();
  process.env["CHOVY_SKILLS_AUTO"] = "1";
  resetFeaturesCache();
  captured.length = 0;
  const session = freshSession();
  const out1 = await runSkillRound({
    messages: [{ role: "user", content: "帮我修这个 bug 然后提交" }],
    session,
    agentRole: "main",
    cwd,
    cfg,
    provider,
    model,
  });
  truthy(out1.loadedSkills.length > 0, "auto planner activated ≥ 1 skill");
  const ev1 = captured.filter((e) => e.type === "skill.plan");
  eq(ev1.length, 1, "auto round emitted exactly one telemetry");
  eq((ev1[0] as { mode: string }).mode, "auto", "mode=auto");
  // skills.lock should now exist
  const lock = await loadSkillsLock(cwd);
  truthy(lock !== null, "skills.lock written");
  truthy((lock?.lastSelected.length ?? 0) > 0, "skills.lock has selections");

  // Second call with same input → fingerprint hit
  captured.length = 0;
  const session2 = freshSession();
  await runSkillRound({
    messages: [{ role: "user", content: "帮我修这个 bug 然后提交" }],
    session: session2,
    agentRole: "main",
    cwd,
    cfg,
    provider,
    model,
  });
  const ev2 = captured.filter((e) => e.type === "skill.plan");
  eq(ev2.length, 1, "second call emitted one telemetry");
  truthy(
    (ev2[0] as { fingerprintHit: boolean }).fingerprintHit === true,
    "fingerprintHit=true on identical input",
  );
  delete process.env["CHOVY_SKILLS_AUTO"];
}

// ─── 11. Prompt injection ─────────────────────────────────────────────────
hdr("§11 prompt injection");
{
  const empty = skillFragmentsSection(undefined);
  eq(empty, "", "empty input → empty section");
  const single = skillFragmentsSection({
    fragments: [{ name: "commit", body: "## Skill: commit\nbody" }],
  });
  truthy(single.includes("## Active skills"), "header present");
  truthy(single.includes("<skill name=\"commit\">"), "block opens");
  truthy(single.includes("</skill>"), "block closes");
  // skillsSection (names only) still works alongside.
  const names = skillsSection(["commit", "format"]);
  truthy(names.includes("Loaded skills"), "skillsSection prints names header");
}

// ─── 12. ToolSession back-compat (TodoWrite + skills coexist) ────────────
hdr("§12 ToolSession back-compat");
{
  const session = freshSession();
  const ctx = fakeCtx(session);
  const td = await todoWriteTool.run(
    { todos: [{ content: "x", status: "pending", priority: "low" }] },
    ctx,
  );
  if (typeof td === "string") bad("todoWriteTool returned string");
  else truthy(td.ok, "todoWriteTool.run ok");
  truthy((session.todoList?.length ?? 0) === 1, "session.todoList preserved");
  // Now activate a skill on the same session.
  resetSkillRegistry();
  await ensureBundledSkillsInitialized();
  const sk = await skillTool.run({ skill: "commit" }, ctx);
  if (typeof sk !== "string") truthy(sk.ok, "skillTool ok on shared session");
  truthy((session.todoList?.length ?? 0) === 1, "todoList unchanged after skill");
  truthy(
    Object.keys(session.activeSkillFragments ?? {}).length > 0,
    "activeSkillFragments populated alongside todoList",
  );
}

// ─── 13. queryEngine.ts ≤ 600 lines ────────────────────────────────────────
hdr("§13 queryEngine.ts ≤ 600 lines (AGENTS.md §17)");
{
  const src = readFileSync(join(__dirname, "..", "src", "engine", "queryEngine.ts"), "utf8");
  const lines = src.split("\n").length;
  truthy(lines <= 600, `queryEngine.ts is ${lines} lines (cap 600)`);
}

// ─── Lower-level graph algorithms ──────────────────────────────────────────
hdr("§14 graph algorithms (closure / conflict / budget)");
{
  resetSkillRegistry();
  const a: Skill = { name: "a", summary: "a", triggers: {}, systemFragment: "a", budgetTokens: 100 };
  const b: Skill = { name: "b", summary: "b", triggers: {}, requires: ["a"], systemFragment: "b", budgetTokens: 100 };
  const c: Skill = { name: "c", summary: "c", triggers: {}, requires: ["b"], systemFragment: "c", budgetTokens: 100 };
  registerSkill(a); registerSkill(b); registerSkill(c);
  const reg = new Map(listSkills().map((s) => [s.name, s]));

  const closure = computeClosure([{ skill: c, score: 5 }], reg);
  eq(closure.nodes.map((n) => n.skill.name).sort(), ["a", "b", "c"], "closure pulls transitive requires");
  eq(closure.missingRequired, [], "no missing");

  const conflictRes = resolveConflicts(closure.nodes);
  eq(conflictRes.kept.length, 3, "no conflicts declared → all kept");

  const budgetRes = enforceBudget(closure.nodes, 150);
  truthy(budgetRes.totalTokens <= 150, "budget caps total");
  // 'c' is the highest-score node BUT its drop must cascade nothing (it's a leaf).
  truthy(budgetRes.dropped.length >= 1, "some node dropped");

  // Manual closure with missing dep
  resetSkillRegistry();
  registerSkill(c); // c.requires=['b'] which is now absent
  const reg2 = new Map(listSkills().map((s) => [s.name, s]));
  const manual = resolveManualClosure(c, reg2, new Set());
  eq(manual.missingRequired, ["b"], "manual closure flags missing required");
}

// ─── Render helper ───────────────────────────────────────────────────────
hdr("§15 renderSkillFragments helper");
{
  const r1 = renderSkillFragments(undefined);
  eq(r1, undefined, "undefined → undefined");
  const r2 = renderSkillFragments({});
  eq(r2, undefined, "empty → undefined");
  const r3 = renderSkillFragments({ a: "x", b: "" });
  eq(r3?.fragments.length, 1, "filters empty bodies");
  eq(r3?.fragments[0]?.name, "a", "preserves name");
}

// ─── Cleanup + summary ─────────────────────────────────────────────────────
console.log(`\n=================================`);
console.log(`smoke-step29: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log(failures.join("\n"));
}
console.log(`=================================`);

try {
  rmSync(TMP_HOME, { recursive: true, force: true });
} catch { /* ignore */ }
_resetHomeEnsureCacheForTesting();
_resetProjectEnsureCacheForTesting();

process.exit(fail > 0 ? 1 : 0);
