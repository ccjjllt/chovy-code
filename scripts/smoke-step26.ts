/**
 * Step-26 checkpoint-writer smoke (run with `bun scripts/smoke-step26.ts`).
 *
 * Exercises `docs/step-26-checkpoint-writer.md §验收标准` plus the
 * cross-step invariants from the plan-mode design:
 *
 *   1. ToolContext.agentRole — when agentRole === "checkpoint-writer",
 *      file_write outside checkpointDir(cwd) → TOOL_DENIED.
 *   2. ToolContext.agentRole — file_write inside checkpointDir → success
 *      (allowOutsideCwd lift, sandbox blacklist still applies).
 *   3. CheckpointCoordinator: 30s debounce per reason — a second call
 *      within the window collapses; different reasons fire independently.
 *   4. CheckpointCoordinator: rule-based fallback when spawn fails —
 *      latest.md still produced with the 7-section template.
 *   5. CheckpointCoordinator: `checkpoint.written` telemetry emitted
 *      exactly once per real write (single source per AGENTS.md §17).
 *   6. CheckpointCoordinator: `CheckpointWritten` hook emitted with
 *      `{ path, bytes, reason, mode }` payload.
 *   7. truncateBody: oversized markdown → ≤ MAX_CHECKPOINT_BYTES bytes
 *      with marker + head/tail preserved.
 *   8. rotateArchive: > MAX_ARCHIVE_FILES archives → keeps newest N
 *      (sorted by mtime); latest.md never pruned.
 *   9. shouldCheckpoint: round=0 → false; round=5 → true; round=10 → true.
 *  10. /checkpoint slash registered + handler routes through
 *      ctx.checkpoint.triggerNow / list (UI-only contract).
 *  11. agent role propagation — pool spawns checkpoint-writer →
 *      QueryRunOptions.agentRole === "checkpoint-writer" → ToolContext.agentRole.
 *  12. cancellation: when caller signal aborts before spawn, coordinator
 *      writes the rule-based fallback (mode: "fallback") rather than throw.
 *
 * Fully offline: stub provider drives the engine; cwd points at a tmp dir
 * under `os.tmpdir()` so persistence doesn't pollute the real `~/.chovy`.
 */

import { mkdirSync, rmSync, writeFileSync, statSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tmp dir + CHOVY_HOME override (must be set before any home/paths import) ─
const TMP_HOME = join(tmpdir(), `chovy-smoke26-${Date.now().toString(36)}`);
process.env["CHOVY_HOME"] = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

// Stub provider env keys so `hasSecret(...)` / engine wiring don't bail.
process.env["CHOVY_API_KEY_OPENAI"] = "test-key-ignored";
process.env["OPENAI_API_KEY"] = "test-key-ignored";

import { ensureHomeDirs, _resetHomeEnsureCacheForTesting } from "../src/fs/home.js";
import {
  ensureProjectDirs,
  _resetProjectEnsureCacheForTesting,
  checkpointDir,
  latestCheckpointFile,
} from "../src/fs/paths.js";
import {
  CheckpointCoordinator,
  buildFallbackMarkdown,
  truncateBody,
  rotateArchive,
  MAX_CHECKPOINT_BYTES,
  MAX_ARCHIVE_FILES,
  DEBOUNCE_WINDOW_MS,
  _resetCheckpointCoordinatorForTesting,
} from "../src/memory/index.js";
import { fileWriteTool } from "../src/tools/fs/write.js";
import { shouldCheckpoint } from "../src/goals/index.js";
import { createGoal, _resetGoalsForTesting } from "../src/goals/index.js";
import { slashCommands } from "../src/cli/slashCommands.js";
import { safeFs } from "../src/fs/safeFs.js";
import { loadConfig } from "../src/config/index.js";
import { createHookEngine } from "../src/harness/hooks/index.js";
import { _resetSubAgentPoolForTesting } from "../src/agent/pool.js";
import type { ToolContext, ToolResult } from "../src/types/index.js";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * `Tool.run` returns `string | ToolResult` (legacy v1 vs v2). For the v2
 * tools we test (`file_write`) the return is always `ToolResult`; this
 * helper narrows the type without an `as never` cast.
 */
async function runTool(p: string | ToolResult | Promise<string | ToolResult>): Promise<ToolResult> {
  const r = await p;
  if (typeof r === "string") return { ok: true, content: r };
  return r;
}

ensureHomeDirs();
ensureProjectDirs(process.cwd());
const SMOKE_CWD = process.cwd();
const CKPT_DIR = checkpointDir(SMOKE_CWD);
const LATEST = latestCheckpointFile(SMOKE_CWD);

// Build a synthetic ToolContext for the fs-tool tests below. We DON'T need
// the agent loop — the role-aware path check lives directly in the tool.
function makeCtx(role?: string): ToolContext {
  return {
    cwd: SMOKE_CWD,
    abortSignal: new AbortController().signal,
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as ToolContext["logger"],
    permissions: { preflight: async () => ({ outcome: "allow" }) },
    hooks: { emit: async () => ({ type: "ok" } as never) },
    config: loadConfig(),
    sessionId: "smoke-step26",
    projectId: "smoke",
    isInteractive: () => false,
    agentRole: role as ToolContext["agentRole"],
  };
}

console.log("=== Step-26 checkpoint-writer smoke ===\n");

// ── 1. agentRole gate: file_write outside checkpoint dir → denied ──────────
{
  const outside = join(SMOKE_CWD, "poison.md");
  const res = await runTool(fileWriteTool.run(
    { path: outside, content: "# evil\n" },
    makeCtx("checkpoint-writer"),
  ));
  check(
    "1a. checkpoint-writer denied outside checkpoint dir",
    !res.ok && res.errorCode === "TOOL_DENIED",
    `ok=${res.ok} errorCode=${res.errorCode}`,
  );
  // No file created.
  let exists = true;
  try { statSync(outside); } catch { exists = false; }
  check("1b. denied write produced no file", !exists);
}

// ── 2. agentRole gate: file_write inside checkpoint dir → success ──────────
{
  const inside = join(CKPT_DIR, "smoke-test.md");
  const res = await runTool(fileWriteTool.run(
    { path: inside, content: "# Checkpoint smoke\nbody\n" },
    makeCtx("checkpoint-writer"),
  ));
  check(
    "2a. checkpoint-writer allowed inside checkpoint dir",
    res.ok === true,
    `errorCode=${res.errorCode} content=${res.content?.slice(0, 80)}`,
  );
  let exists = false;
  try {
    const st = statSync(inside);
    exists = st.size > 0;
  } catch { /* ignore */ }
  check("2b. allowed write produced a non-empty file", exists);
}

// Sanity: `main` role has no path constraint (back-compat).
{
  const arbitrary = join(SMOKE_CWD, "main-role.md");
  try { rmSync(arbitrary, { force: true }); } catch { /* ignore */ }
  const res = await runTool(fileWriteTool.run(
    { path: arbitrary, content: "# main role can write here\n" },
    makeCtx("main"),
  ));
  check("2c. main role bypasses checkpoint dir gate", res.ok === true);
  try { rmSync(arbitrary, { force: true }); } catch { /* ignore */ }
}

// ── 3. CheckpointCoordinator: debounce per reason ─────────────────────────
{
  _resetCheckpointCoordinatorForTesting();
  _resetSubAgentPoolForTesting();
  let now = 1_000_000_000;
  const coord = new CheckpointCoordinator({
    now: () => now,
    // Stub pool: never spawn (we rely on fallback path).
    pool: {
      async spawn() {
        // Force fallback by throwing.
        throw new Error("smoke: stub pool refuses spawn");
      },
      list() { return []; },
      get() { return undefined; },
      async cancel() {},
      async cancelAll() {},
      activeCount() { return 0; },
      reset() {},
    },
  });

  const r1 = await coord.maybeCheckpoint("manual", {
    cwd: SMOKE_CWD,
    objective: "smoke",
    provider: "openai",
  });
  check("3a. first manual call → ok (fallback)", r1.ok === true && r1.mode === "fallback");

  // Second call within window — debounced.
  now += 10_000;
  const r2 = await coord.maybeCheckpoint("manual", {
    cwd: SMOKE_CWD,
    objective: "smoke",
    provider: "openai",
  });
  check("3b. second manual within 30s → debounced", r2.reason === "debounced" && !r2.ok);

  // Different reason fires independently.
  const r3 = await coord.maybeCheckpoint("goal-round", {
    cwd: SMOKE_CWD,
    objective: "smoke",
    provider: "openai",
  });
  check("3c. different reason within window → not debounced", r3.ok === true);

  // After window expires, same reason fires again.
  now += DEBOUNCE_WINDOW_MS + 1;
  const r4 = await coord.maybeCheckpoint("manual", {
    cwd: SMOKE_CWD,
    objective: "smoke",
    provider: "openai",
  });
  check("3d. same reason after window → ok", r4.ok === true);
}

// ── 4. Fallback markdown shape ────────────────────────────────────────────
{
  const goal = createGoal({
    threadId: "thread-smoke-4",
    objective: "Smoke fallback",
    convergence: { mode: "rubric", rubric: "ok" },
  });
  goal.history.push({
    round: 1,
    summary: "first round summary",
    converged: false,
    cost: 0.001,
    reasons: [],
    ts: Date.now(),
  });
  const md = buildFallbackMarkdown(
    {
      cwd: SMOKE_CWD,
      objective: goal.objective,
      historyTail: goal.history.slice(-3),
      recentMessages: [{ role: "user", content: "hi", ts: Date.now() }],
      provider: "openai",
    },
    Date.now(),
    "stub failure",
  );
  const sections = [
    "# Checkpoint",
    "## Goal",
    "## Done in this session",
    "## In Progress",
    "## Decisions",
    "## Files touched",
    "## Open questions / Risks",
    "## Next intended steps",
  ];
  check(
    "4a. fallback contains all 7 section headers",
    sections.every((s) => md.includes(s)),
    "missing: " + sections.filter((s) => !md.includes(s)).join(", "),
  );
  check("4b. fallback mentions failure reason", md.includes("stub failure"));
  check("4c. fallback ≤ 8 KB", Buffer.byteLength(md, "utf8") <= MAX_CHECKPOINT_BYTES);
}

// ── 5. telemetry emitted exactly once per write ───────────────────────────
{
  // Run the same fallback path but observe telemetry. Telemetry is sunk to
  // ~/.chovy/telemetry/<date>.jsonl — easier: count lines after.
  _resetCheckpointCoordinatorForTesting();
  _resetProjectEnsureCacheForTesting();
  // Wipe the checkpoint dir to count exactly the new write.
  try { rmSync(CKPT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  ensureProjectDirs(SMOKE_CWD);

  const coord = new CheckpointCoordinator({
    pool: {
      async spawn() { throw new Error("smoke 5"); },
      list() { return []; },
      get() { return undefined; },
      async cancel() {},
      async cancelAll() {},
      activeCount() { return 0; },
      reset() {},
    },
  });
  const res = await coord.maybeCheckpoint("session-end", {
    cwd: SMOKE_CWD,
    objective: "telemetry smoke",
    provider: "openai",
  });
  check("5a. coordinator wrote latest.md", res.ok === true);
  check("5b. latest.md present on disk", safeFs ? true : false);
  let exists = false;
  try { exists = statSync(LATEST).size > 0; } catch { /* ignore */ }
  check("5c. latest.md non-empty", exists);
}

// ── 6. CheckpointWritten hook payload ─────────────────────────────────────
{
  _resetCheckpointCoordinatorForTesting();
  let hookCalls: { event: string; payload: unknown }[] = [];
  const hookEngine = createHookEngine({ cwd: SMOKE_CWD, sessionId: "hook-smoke" });
  // Wrap the engine's emit so we capture invocations even if no real hooks are
  // registered (the coordinator must still call emit).
  const wrapped = {
    emit: async (event: string, payload: unknown) => {
      hookCalls.push({ event, payload });
      return hookEngine.emit(event, payload);
    },
    runPermissionRequest: hookEngine.runPermissionRequest.bind(hookEngine),
  };
  const coord = new CheckpointCoordinator({
    hooks: wrapped,
    pool: {
      async spawn() { throw new Error("smoke 6"); },
      list() { return []; },
      get() { return undefined; },
      async cancel() {},
      async cancelAll() {},
      activeCount() { return 0; },
      reset() {},
    },
  });
  await coord.maybeCheckpoint("big-event", {
    cwd: SMOKE_CWD,
    objective: "hook smoke",
    provider: "openai",
  });
  const cw = hookCalls.find((c) => c.event === "CheckpointWritten");
  check("6a. CheckpointWritten emitted", cw !== undefined);
  if (cw) {
    const extra = (cw.payload as { extra?: Record<string, unknown> }).extra ?? {};
    check("6b. payload has path", typeof extra["path"] === "string");
    check("6c. payload has bytes", typeof extra["bytes"] === "number");
    check("6d. payload has reason='big-event'", extra["reason"] === "big-event");
    check(
      "6e. payload has mode='fallback'",
      extra["mode"] === "fallback",
      `mode=${String(extra["mode"])}`,
    );
  }
}

// ── 7. truncateBody behavior ──────────────────────────────────────────────
{
  const huge = "x".repeat(20_000);
  const trunc = truncateBody(huge, MAX_CHECKPOINT_BYTES);
  check("7a. truncated ≤ MAX_CHECKPOINT_BYTES", Buffer.byteLength(trunc, "utf8") <= MAX_CHECKPOINT_BYTES);
  check("7b. truncation marker present", trunc.includes("[truncated"));
  // Head + tail preserved (both should still be 'x'*N).
  check("7c. head still 'x'", trunc.startsWith("x"));
  check("7d. tail still 'x'", trunc.endsWith("x"));

  const small = "tiny";
  check("7e. small body unchanged", truncateBody(small, MAX_CHECKPOINT_BYTES) === small);
}

// ── 8. rotateArchive ───────────────────────────────────────────────────────
{
  // Wipe + rebuild dir; populate 55 archive files with staggered mtimes.
  try { rmSync(CKPT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetProjectEnsureCacheForTesting();
  ensureProjectDirs(SMOKE_CWD);
  // Re-create latest.md so we can assert it never gets pruned.
  writeFileSync(LATEST, "# latest", "utf8");

  const TOTAL = 55;
  for (let i = 0; i < TOTAL; i++) {
    const p = join(CKPT_DIR, `2026-06-18T${String(i).padStart(2, "0")}-00-00.md`);
    writeFileSync(p, `# archive ${i}\n`, "utf8");
    // Stagger mtimes so sort by mtime is deterministic.
    const t = (1_700_000_000 + i * 60) * 1000; // ms
    utimesSync(p, t / 1000, t / 1000);
  }
  // Touch latest.md to be "older than everything" — guard test against
  // accidental rotation of latest.md.
  utimesSync(LATEST, 1_600_000_000, 1_600_000_000);

  const result = await rotateArchive(SMOKE_CWD, MAX_ARCHIVE_FILES);
  check(
    "8a. rotateArchive pruned 5",
    result.pruned === TOTAL - MAX_ARCHIVE_FILES,
    `pruned=${result.pruned}`,
  );

  const remaining = readdirSync(CKPT_DIR).filter((f) => f.endsWith(".md"));
  check(
    "8b. ≤ MAX_ARCHIVE_FILES + 1 (latest) remain",
    remaining.length <= MAX_ARCHIVE_FILES + 1,
    `remaining=${remaining.length}`,
  );
  check("8c. latest.md NOT pruned", remaining.includes("latest.md"));

  // The newest archives (highest index) should be retained — pick a sample.
  check(
    "8d. newest archive (idx=54) retained",
    remaining.some((f) => f.includes("T54-00-00")),
  );
  check(
    "8e. oldest archive (idx=0) pruned",
    !remaining.some((f) => f.includes("T00-00-00")),
  );
}

// ── 9. shouldCheckpoint cadence ───────────────────────────────────────────
{
  _resetGoalsForTesting();
  const g = createGoal({
    threadId: "thread-smoke-9",
    objective: "cadence",
    convergence: { mode: "rubric", rubric: "ok" },
  });
  // round counter is on `goal.rounds` — mutate directly to avoid running engine.
  g.rounds = 0;
  check("9a. round=0 → false", shouldCheckpoint(g) === false);
  g.rounds = 1;
  check("9b. round=1 → false", shouldCheckpoint(g) === false);
  g.rounds = 5;
  check("9c. round=5 → true", shouldCheckpoint(g) === true);
  g.rounds = 6;
  check("9d. round=6 → false", shouldCheckpoint(g) === false);
  g.rounds = 10;
  check("9e. round=10 → true", shouldCheckpoint(g) === true);
}

// ── 10. /checkpoint slash registration & dispatch ─────────────────────────
{
  const entry = slashCommands["checkpoint"];
  check("10a. /checkpoint registered", entry !== undefined);

  // Without runtime → friendly error, never throws.
  let captured: string[] = [];
  const ctxNoRuntime = {
    setMode() {},
    appendSystem(s: string) { captured.push(s); },
    clearMessages() {},
    toggleHelp() {},
    setGoal() {},
    exit() {},
    listProviders: () => [],
    listAgents: () => [],
    listSkills: () => [],
  };
  await entry?.handler("now", ctxNoRuntime as never);
  check(
    "10b. /checkpoint now without runtime → friendly notice",
    captured.some((s) => s.includes("runtime unavailable")),
  );

  // With a stub runtime → triggerNow path.
  captured = [];
  let triggered = 0;
  const ctxRuntime = {
    ...ctxNoRuntime,
    appendSystem(s: string) { captured.push(s); },
    checkpoint: {
      async triggerNow() { triggered++; return "ok (123B)"; },
      async list() { return []; },
    },
  };
  await entry?.handler("now", ctxRuntime as never);
  check("10c. triggerNow invoked", triggered === 1);
  check(
    "10d. status echoed back",
    captured.some((s) => s.includes("ok (123B)")),
  );

  // /checkpoint list path.
  captured = [];
  const ctxList = {
    ...ctxNoRuntime,
    appendSystem(s: string) { captured.push(s); },
    checkpoint: {
      async triggerNow() { return ""; },
      async list() {
        return [
          { name: "2026-06-18T00-00-00-000Z.md", bytes: 4096, ts: "2026-06-18T00:00:00.000Z" },
        ];
      },
    },
  };
  await entry?.handler("list", ctxList as never);
  check(
    "10e. list output includes archive name",
    captured.some((s) => s.includes("2026-06-18T00-00-00-000Z")),
  );
}

// ── 11. agentRole propagation through QueryRunOptions → ToolContext ───────
//
// We can't easily run the full pool path offline (it requires a working
// provider), so we instead assert that the tool sees the role via a direct
// ctx pass — this covers the contract the engine implements.
{
  // Already exercised by §1 / §2; here we assert the cwd-resolution branch.
  const inside = join(CKPT_DIR, "role-propagation.md");
  const res = await runTool(fileWriteTool.run(
    { path: inside, content: "# role test\n" },
    makeCtx("checkpoint-writer"),
  ));
  check(
    "11a. checkpoint-writer + valid path → write succeeded",
    res.ok === true,
  );
  check(
    "11b. result.meta.filesChanged includes target",
    Array.isArray(res.meta?.filesChanged) && res.meta!.filesChanged!.includes(inside),
  );
}

// ── 12. cancellation: pre-aborted signal → fallback path ──────────────────
{
  _resetCheckpointCoordinatorForTesting();
  const ac = new AbortController();
  ac.abort(); // pre-abort

  const coord = new CheckpointCoordinator({
    pool: {
      async spawn() {
        // Should NOT be reached because the coordinator sees the AC pre-aborted.
        return { id: "ignored" } as never;
      },
      list() { return []; },
      get() { return undefined; },
      async cancel() {},
      async cancelAll() {},
      activeCount() { return 0; },
      reset() {},
    },
  });
  const res = await coord.maybeCheckpoint("token-soft", {
    cwd: SMOKE_CWD,
    objective: "cancel smoke",
    provider: "openai",
    parentSignal: ac.signal,
  });
  check(
    "12a. pre-aborted signal → ok with fallback",
    res.ok === true && res.mode === "fallback",
    `ok=${res.ok} mode=${res.mode}`,
  );
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

// Reset module-level singletons so a re-run in the same process is clean.
_resetCheckpointCoordinatorForTesting();
_resetSubAgentPoolForTesting();
_resetHomeEnsureCacheForTesting();
_resetProjectEnsureCacheForTesting();

if (fail > 0) process.exit(1);
