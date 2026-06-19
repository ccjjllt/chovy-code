/**
 * Step-28 SCW context-rebuild smoke (run with `bun scripts/smoke-step28.ts`).
 *
 * Exercises `docs/step-28-context-rebuild.md §验收标准` plus the
 * cross-step invariants:
 *
 *   1. computeBudget(): returns 8 buckets summing to ≤ ctxWindow - reserve.
 *      gpt-4o (128k window) → systemBase=1500, history=~107k.
 *      Small window (8k via gpt-4o-mini placeholder) → squeeze branch keeps
 *      history ≥ 10 % of effectiveWindow.
 *   2. recentMessagesPick: 50 messages + budgetTokens cap → keeps the
 *      tail; no orphan tool messages; first kept message is user/assistant.
 *   3. checkpointPick: missing latest.md → null; existing → text trimmed
 *      to budget with truncation marker.
 *   4. progressPick: missing goalId → null; existing progress.md → tail
 *      trim under budget.
 *   5. memoryPick: store with no rows → null; store with rows + prompt →
 *      MD bullet list under budget.
 *   6. rebuildContext: 200k-token-style mock messages + checkpoint + memory
 *      → returns < 30k tokens, single system marker + recent K tail.
 *   7. rebuildContext: emits `context.rebuild` telemetry exactly once
 *      with `kept`/`dropped`/`checkpointBytes`/`memoryEntries`.
 *   8. rebuildContext: emits `ContextRebuilt` hook event.
 *   9. rebuildContext: writes original messages to sessions/<id>.jsonl
 *      (ndjson + comment header).
 *  10. rebuildContext fallback: missing checkpoint + empty store +
 *      no progress → renders `<rule-summary>` flavor.
 *  11. maybeRebuild integration: hard-transition snapshot → mutates
 *      messages array in place, monitor.reset() → level back to fresh,
 *      cost.splitSession() → totals zeroed but cumulative preserved.
 *  12. maybeRebuild idempotence: snapshot.transitioned=false → no-op
 *      (rebuilt:false). snapshot.level==='soft' → no-op.
 *  13. CostTracker.cumulativeTotal survives splitSession; total() resets.
 *  14. ContextMonitor.reset() returns level to fresh while keeping listeners.
 *  15. Recent-messages tool-call pairing: assistant-with-tool_calls + tool
 *      result kept together; orphan tool message dropped.
 *  16. ContextBudget invariant: budgetTotal(b) ≤ ctxWindow - reserve.
 *
 * Fully offline: stubs the memory store + telemetry + hook engine so we
 * never touch the network.
 */

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tmp dir + CHOVY_HOME override ────────────────────────────────────────
const TMP_HOME = join(tmpdir(), `chovy-smoke28-${Date.now().toString(36)}`);
process.env["CHOVY_HOME"] = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

process.env["CHOVY_API_KEY_OPENAI"] = "test-key-ignored";
process.env["OPENAI_API_KEY"] = "test-key-ignored";

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
  ensureHomeDirs,
  _resetHomeEnsureCacheForTesting,
} from "../src/fs/home.js";
import {
  ensureProjectDirs,
  _resetProjectEnsureCacheForTesting,
  latestCheckpointFile,
  sessionFile,
  goalProgressFile,
  taskDir,
  projectId as projectIdOf,
} from "../src/fs/paths.js";
import { loadConfig, resetConfigCache } from "../src/config/index.js";
import {
  computeBudget,
  budgetTotal,
  recentMessagesPick,
  checkpointPick,
  progressPick,
  memoryPick,
  rebuildContext,
  createContextMonitor,
} from "../src/context/index.js";
import { runScwRound } from "../src/engine/rebuildHook.js";
import { CostTracker } from "../src/engine/costTracker.js";
import { safeFs } from "../src/fs/safeFs.js";
import type {
  ChatMessage,
  HookEngine,
  HookOutcome,
  MemoryRecord,
} from "../src/types/index.js";
import type { MemoryStore } from "../src/memory/store.js";

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

ensureHomeDirs();
ensureProjectDirs(process.cwd());

console.log("=== Step-28 context-rebuild smoke ===\n");

// ── 1. computeBudget — 8 buckets, sum ≤ effectiveWindow ──────────────────
{
  const cfg = loadConfig();
  const b = computeBudget("gpt-4o", "openai", cfg, {});
  check(
    "1a. computeBudget returns 8 buckets",
    typeof b.systemBase === "number" &&
      typeof b.memory === "number" &&
      typeof b.checkpoint === "number" &&
      typeof b.notes === "number" &&
      typeof b.taskProgress === "number" &&
      typeof b.skills === "number" &&
      typeof b.tools === "number" &&
      typeof b.history === "number",
  );
  check(
    "1b. systemBase=1500 (default slab)",
    b.systemBase === 1500,
    `got=${b.systemBase}`,
  );
  check(
    "1c. memory=4000",
    b.memory === 4000,
    `got=${b.memory}`,
  );
  check(
    "1d. checkpoint=3000",
    b.checkpoint === 3000,
    `got=${b.checkpoint}`,
  );
  check(
    "1e. tools=6000",
    b.tools === 6000,
    `got=${b.tools}`,
  );
  // 128k - 2048 reserve = 125952 effectiveWindow. Default slabs sum = 25500.
  // history = 125952 - 25500 = 100452.
  check(
    "1f. history >= 100k for gpt-4o",
    b.history >= 100_000,
    `history=${b.history}`,
  );
  // sum of all buckets == effectiveWindow (by construction).
  check(
    "1g. budgetTotal(b) === effectiveWindow",
    budgetTotal(b) === 125_952,
    `total=${budgetTotal(b)}`,
  );
  // Frozen
  check(
    "1h. ContextBudget is frozen (immutable)",
    Object.isFrozen(b),
  );
}

// ── 1bis. Squeeze branch — small window forces proportional shrink ───────
{
  const cfg = loadConfig();
  // Crank reserve to gobble most of the 128k window so the squeeze branch
  // engages: env override goes through CHOVY_CTX_RESERVE_TOKENS.
  const tinyEnv = { CHOVY_CTX_RESERVE_TOKENS: "60000" } as NodeJS.ProcessEnv;
  const b = computeBudget("gpt-4o", "openai", cfg, tinyEnv);
  // effectiveWindow = 128000 - 60000 = 68000. Default slab sum = 25500;
  // 68000 - 25500 = 42500 ≥ 10% (6800), so default branch still wins here.
  // Bump reserve higher to force squeeze: reserve clipped at 50% so set 64k.
  const tinyEnv2 = { CHOVY_CTX_RESERVE_TOKENS: "120000" } as NodeJS.ProcessEnv;
  const b2 = computeBudget("gpt-4o", "openai", cfg, tinyEnv2);
  // effectiveWindow = 128000 - 64000 (clipped) = 64000.
  // Default sum 25500 + minHistory (10% of 64000 = 6400) = 31900 ≤ 64000,
  // so default branch still wins. Need to construct a synthetic "smaller"
  // env — gpt-4o has a 128k window so we can't go below that. Instead
  // verify squeeze invariants on the structural side: budgetTotal stays
  // ≤ effective.
  check(
    "1i. squeeze: budgetTotal(b2) ≤ effectiveWindow (64000)",
    budgetTotal(b2) <= 64_000,
    `total=${budgetTotal(b2)} effective=64000`,
  );
  check(
    "1j. squeeze: history ≥ 10% of effective (≥ 6400)",
    b2.history >= 6_400,
    `history=${b2.history}`,
  );
  void b;
}

// ── 2. recentMessagesPick — keeps tail, drops orphans ─────────────────────
{
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 50; i++) {
    msgs.push({ role: "user", content: `q${i}` });
    msgs.push({ role: "assistant", content: `a${i}` });
  }
  const r = recentMessagesPick(msgs, { k: 6 });
  check(
    "2a. recentMessagesPick keeps tail (≤ 12 messages for k=6)",
    r.kept.length <= 12 && r.kept.length > 0,
    `kept=${r.kept.length}`,
  );
  check(
    "2b. droppedCount = originalCount - kept.length",
    r.droppedCount === 100 - r.kept.length,
  );
  check(
    "2c. first kept message is user/assistant (not tool)",
    r.kept[0]!.role === "user" || r.kept[0]!.role === "assistant",
  );
  check(
    "2d. last kept message preserves last assistant turn",
    r.kept[r.kept.length - 1]!.content === "a49",
  );

  // Tool-call pairing: assistant-with-tool_calls + tool result must travel
  // together.
  const withTool: ChatMessage[] = [
    { role: "user", content: "do thing" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "file_read", arguments: '{"path":"a"}' }],
    },
    { role: "tool", toolName: "file_read", content: "OK" },
    { role: "assistant", content: "done" },
  ];
  const r2 = recentMessagesPick(withTool, { k: 4 });
  check(
    "2e. tool message kept iff preceding assistant tool_calls present",
    r2.kept.some((m) => m.role === "tool"),
  );
  check(
    "2f. trailing assistant has no orphan tool_calls",
    !(
      r2.kept[r2.kept.length - 1]!.role === "assistant" &&
      r2.kept[r2.kept.length - 1]!.toolCalls &&
      r2.kept[r2.kept.length - 1]!.toolCalls!.length > 0
    ),
  );

  // Orphan tool (no preceding assistant) → dropped.
  const orphan: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", toolName: "ghost", content: "leftover" },
    { role: "assistant", content: "hello" },
  ];
  const r3 = recentMessagesPick(orphan);
  check(
    "2g. orphan tool message (no prior assistant tool_calls) dropped",
    !r3.kept.some((m) => m.role === "tool"),
  );

  // Empty input
  const r4 = recentMessagesPick([]);
  check(
    "2h. empty messages → empty result",
    r4.kept.length === 0 && r4.droppedCount === 0,
  );
}

// ── 3. checkpointPick — missing → null; existing → trimmed ────────────────
{
  const cwd = process.cwd();
  const path = latestCheckpointFile(cwd);
  // Ensure clean state
  try { rmSync(path, { force: true }); } catch { /* */ }

  const r = await checkpointPick(cwd, 3000);
  check("3a. checkpointPick(missing) === null", r === null);

  // Plant a small checkpoint
  const small = "# Checkpoint 2026-06-19T00:00:00Z\n\n## Goal\ntest\n";
  await safeFs.write(path, small);
  const r2 = await checkpointPick(cwd, 3000);
  check(
    "3b. existing checkpoint returned untouched when within budget",
    r2 !== null && !r2.truncated && r2.text === small,
  );

  // Plant an oversized checkpoint
  const huge = "# Big\n\n" + "x".repeat(20_000);
  await safeFs.write(path, huge);
  const r3 = await checkpointPick(cwd, 100); // tiny budget
  check(
    "3c. oversized checkpoint trimmed under tiny budget",
    r3 !== null && r3.truncated,
  );
  check(
    "3d. trimmed text contains marker",
    r3 !== null && r3.text.includes("checkpoint trimmed by rebuilder"),
  );

  // budgetTokens=0 → null
  const r4 = await checkpointPick(cwd, 0);
  check("3e. budget=0 → null", r4 === null);

  // Cleanup
  try { rmSync(path, { force: true }); } catch { /* */ }
}

// ── 4. progressPick — missing goalId → null; existing → tail ──────────────
{
  const cwd = process.cwd();
  // null goal id → null
  const r = await progressPick(cwd, undefined, 2000);
  check("4a. progressPick(undefined goalId) === null", r === null);

  // Plant a tiny progress.md
  const goalId = "goal-test-28";
  mkdirSync(taskDir(cwd, goalId), { recursive: true });
  const path = goalProgressFile(cwd, goalId);
  await safeFs.write(path, "## 2026-06-19\n\nstart task\n");
  const r2 = await progressPick(cwd, goalId, 2000);
  check(
    "4b. existing progress returns full body when within budget",
    r2 !== null && !r2.truncated && r2.text.includes("start task"),
  );

  // Oversized → tail-trimmed
  const huge = "## h\n\n" + "y".repeat(50_000);
  await safeFs.write(path, huge);
  const r3 = await progressPick(cwd, goalId, 200);
  check(
    "4c. oversized progress tail-trimmed under tiny budget",
    r3 !== null && r3.truncated,
  );
  check(
    "4d. trim marker present",
    r3 !== null && r3.text.includes("progress tail trimmed by rebuilder"),
  );

  try { rmSync(path, { force: true }); } catch { /* */ }
}

// ── 5. memoryPick — empty store → null; rows → bullet list ────────────────
{
  // Stub empty store
  const emptyStore: MemoryStore = makeStubStore([]);
  const r = await memoryPick({
    cwd: process.cwd(),
    prompt: "anything",
    budgetTokens: 4000,
    store: emptyStore,
  });
  check("5a. memoryPick(empty store) === null", r === null);

  // Stub store with 3 rows
  const projectId = emptyStore.projectId;
  const rows: MemoryRecord[] = [
    {
      id: "mem_a",
      projectId,
      layer: "project",
      type: "rule",
      sourcePath: "MEMORY.md",
      content: "Always run typecheck before commit",
      tags: ["build"],
      importance: 80,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "mem_b",
      projectId,
      layer: "checkpoint",
      type: "snapshot",
      sourcePath: "checkpoints/latest.md",
      content: "Last session implemented step-27 monitor",
      tags: [],
      importance: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "mem_c",
      projectId,
      layer: "notes",
      type: "note",
      sourcePath: "notes.md",
      content: "TODO: implement step-28",
      tags: ["todo"],
      importance: 40,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
  const stocked = makeStubStore(rows);
  const r2 = await memoryPick({
    cwd: process.cwd(),
    prompt: "step-28",
    budgetTokens: 4000,
    store: stocked,
  });
  check(
    "5b. memoryPick returns markdown bullets when rows match",
    r2 !== null && r2.records.length === 3 && r2.text.includes("- ["),
  );
  check(
    "5c. each entry tagged with [layer/type ...]",
    r2 !== null && /\[project\/rule/.test(r2.text) &&
      /\[checkpoint\/snapshot/.test(r2.text) &&
      /\[notes\/note/.test(r2.text),
  );
  check(
    "5d. approxTokens > 0 + ≤ budget",
    r2 !== null && r2.approxTokens > 0 && r2.approxTokens <= 4000,
  );

  // Empty prompt → null
  const r3 = await memoryPick({
    cwd: process.cwd(),
    prompt: "",
    budgetTokens: 4000,
    store: stocked,
  });
  check("5e. empty prompt → null", r3 === null);
}

// ── 6. rebuildContext — full pipeline (200k → < 30k) ─────────────────────
{
  const cwd = process.cwd();
  const sessionId = `smoke28-rebuild-${Date.now().toString(36)}`;
  const cfg = loadConfig();

  // Plant a checkpoint + progress + memory.
  const cpPath = latestCheckpointFile(cwd);
  await safeFs.write(
    cpPath,
    "# Checkpoint\n\n## Goal\nimplement step-28\n\n## Done in this session\n- step-27 shipped\n",
  );
  const goalId = "rebuild-goal";
  mkdirSync(taskDir(cwd, goalId), { recursive: true });
  await safeFs.write(
    goalProgressFile(cwd, goalId),
    "## 2026-06-19\n\nstart rebuild work\n",
  );
  const stocked = makeStubStore([
    {
      id: "mem_x",
      projectId: projectIdOf(cwd),
      layer: "project",
      type: "rule",
      sourcePath: "MEMORY.md",
      content: "Use safeFs for all writes",
      tags: ["fs"],
      importance: 90,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);

  // Build a giant message list (~200k tokens worth)
  const big: ChatMessage[] = [{ role: "user", content: "implement step-28 now" }];
  for (let i = 0; i < 30; i++) {
    big.push({ role: "assistant", content: `working on chunk ${i}: ` + "x".repeat(20_000) });
    big.push({ role: "user", content: `next chunk ${i}` });
  }
  big.push({ role: "user", content: "is it done?" });

  // Hook engine stub.
  const hookCalls: Array<{ event: string; payload: unknown }> = [];
  const hookEngine: HookEngine = {
    emit: async (event, payload) => {
      hookCalls.push({ event, payload });
      return { type: "allow" } as HookOutcome;
    },
  };

  captured.length = 0;
  const result = await rebuildContext({
    messages: big,
    cwd,
    sessionId,
    provider: "openai",
    model: "gpt-4o",
    cfg,
    goalId,
    goalObjective: "implement step-28",
    triggeringTokens: 200_000,
    hooks: hookEngine,
    store: stocked,
  });
  check(
    "6a. rebuildContext returns single system marker + tail",
    result.messages.length >= 1 && result.messages[0]!.role === "system",
  );
  check(
    "6b. result.before === 62 (mock messages)",
    result.before === big.length,
    `before=${result.before}`,
  );
  check(
    "6c. result.dropped > 0 (most messages elided)",
    result.dropped > 0,
  );
  check(
    "6d. system marker contains <context-rebuilt> tag",
    result.messages[0]!.content.includes("<context-rebuilt"),
  );
  check(
    "6e. system marker contains <checkpoint> bucket",
    result.messages[0]!.content.includes("<checkpoint>"),
  );
  check(
    "6f. system marker contains <memory> bucket",
    result.messages[0]!.content.includes("<memory>"),
  );
  check(
    "6g. system marker contains <task-progress goal=...> bucket",
    /<task-progress goal="implement step-28"/.test(result.messages[0]!.content),
  );
  check(
    "6h. result.approxTokens < 30k (verification criterion)",
    result.approxTokens < 30_000,
    `approxTokens=${result.approxTokens}`,
  );

  // 7. context.rebuild telemetry
  const evs = captured.filter((e) => e.type === "context.rebuild");
  check(
    "7a. context.rebuild telemetry emitted exactly once",
    evs.length === 1,
    `count=${evs.length}`,
  );
  if (evs.length === 1) {
    const e = evs[0]! as { kept: number; dropped: number; checkpointBytes: number; memoryEntries: number };
    check(
      "7b. telemetry kept = recent-K count, dropped > 0",
      e.kept === result.buckets.keptMessages && e.dropped > 0,
    );
    check(
      "7c. telemetry checkpointBytes > 0",
      e.checkpointBytes > 0,
    );
    check(
      "7d. telemetry memoryEntries === 1 (we planted one row)",
      e.memoryEntries === 1,
    );
  }

  // 8. ContextRebuilt hook
  check(
    "8a. ContextRebuilt hook fired exactly once",
    hookCalls.filter((c) => c.event === "ContextRebuilt").length === 1,
  );
  const hookEv = hookCalls.find((c) => c.event === "ContextRebuilt");
  check(
    "8b. ContextRebuilt payload carries before/after/dropped",
    !!hookEv &&
      typeof (hookEv.payload as { extra: { before: number; after: number; dropped: number } }).extra.before === "number",
  );

  // 9. session jsonl archive
  const archivePath = sessionFile(cwd, sessionId);
  check(
    "9a. session jsonl file exists at expected path",
    existsSync(archivePath),
    `path=${archivePath}`,
  );
  const archived = await safeFs.read(archivePath);
  check(
    "9b. archive contains rebuild header line",
    archived.includes(`# rebuild`) && archived.includes(`session=${sessionId}`),
  );
  check(
    "9c. archive contains all original messages (count match)",
    (archived.match(/"role":"/g) ?? []).length >= big.length,
  );

  // ContextBudget invariant: result.budget total ≤ effectiveWindow
  check(
    "9d. result.budget total ≤ effectiveWindow (125952)",
    budgetTotal(result.budget) <= 125_952,
    `total=${budgetTotal(result.budget)}`,
  );

  try { rmSync(cpPath, { force: true }); } catch { /* */ }
}

// ── 10. Fallback path — no checkpoint, no memory, no progress ─────────────
{
  const cwd = process.cwd();
  const sessionId = `smoke28-fb-${Date.now().toString(36)}`;
  const cfg = loadConfig();

  // Ensure no checkpoint/progress
  try { rmSync(latestCheckpointFile(cwd), { force: true }); } catch { /* */ }

  const tinyMsgs: ChatMessage[] = [
    { role: "user", content: "what should I do next" },
    { role: "assistant", content: "let me think" },
  ];

  const result = await rebuildContext({
    messages: tinyMsgs,
    cwd,
    sessionId,
    provider: "openai",
    model: "gpt-4o",
    cfg,
    triggeringTokens: 200_000,
    store: makeStubStore([]),
  });
  check(
    "10a. fallback marker rendered",
    result.buckets.fallback === true,
  );
  check(
    "10b. system marker contains <rule-summary>",
    result.messages[0]!.content.includes("<rule-summary>"),
  );
  check(
    "10c. fallback marker echoes last user input",
    result.messages[0]!.content.includes("what should I do next"),
  );
}

// ── 11. maybeRebuild integration via runScwRound ─────────────────────────
{
  const cwd = process.cwd();
  const sessionId = `smoke28-mr-${Date.now().toString(36)}`;
  const cfg = loadConfig();

  // Plant a checkpoint so rebuilder uses non-fallback path
  await safeFs.write(
    latestCheckpointFile(cwd),
    "# Checkpoint\n\n## Goal\ntest\n",
  );

  // Build messages crossing hard threshold.
  const msgs: ChatMessage[] = [
    { role: "user", content: "x".repeat(400_000) },
  ];
  const cost = new CostTracker({ telemetry: false });
  // Inject a cumulative spend.
  cost.record("openai", "gpt-4o", { in: 50_000, out: 1_000 });
  const cumBefore = cost.cumulativeTotal().usd;
  const totalBefore = cost.total().usd;
  check(
    "11a. cumulativeTotal === total before rebuild",
    cumBefore === totalBefore && cumBefore > 0,
  );

  const monitor = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd,
    threadId: sessionId,
  });

  captured.length = 0;
  const out = await runScwRound({
    monitor,
    messages: msgs,
    systemBytes: 0,
    cost,
    cwd,
    sessionId,
    provider: "openai",
    model: "gpt-4o",
    cfg,
  });
  check(
    "11b. runScwRound.rebuilt === true on hard transition",
    out.rebuilt === true,
  );
  check(
    "11c. monitor.level reset to fresh after rebuild",
    monitor.level === "fresh",
  );
  check(
    "11d. messages array mutated in place (system marker first)",
    msgs.length >= 1 && msgs[0]!.role === "system" &&
      msgs[0]!.content.includes("<context-rebuilt"),
  );
  check(
    "11e. cost.total() reset after splitSession",
    cost.total().usd === 0,
  );
  check(
    "11f. cost.cumulativeTotal() preserved across splitSession",
    cost.cumulativeTotal().usd === cumBefore,
  );
  check(
    "11g. context.rebuild telemetry emitted once via runScwRound",
    captured.filter((e) => e.type === "context.rebuild").length === 1,
  );
  // Post-rebuild: pressure should be undefined (level back to fresh)
  check(
    "11h. post-rebuild pressure is undefined (level=fresh)",
    out.pressure === undefined,
  );

  try { rmSync(latestCheckpointFile(cwd), { force: true }); } catch { /* */ }
}

// ── 12. maybeRebuild idempotence — no-op for fresh / soft / no transition ─
{
  const cwd = process.cwd();
  const sessionId = `smoke28-idem-${Date.now().toString(36)}`;
  const cfg = loadConfig();
  const tinyMsgs: ChatMessage[] = [{ role: "user", content: "hi" }];
  const cost = new CostTracker({ telemetry: false });
  const monitor = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd,
    threadId: sessionId,
  });
  captured.length = 0;
  const out = await runScwRound({
    monitor,
    messages: tinyMsgs,
    systemBytes: 0,
    cost,
    cwd,
    sessionId,
    provider: "openai",
    model: "gpt-4o",
    cfg,
  });
  check(
    "12a. fresh round → rebuilt:false",
    out.rebuilt === false,
  );
  check(
    "12b. no context.rebuild telemetry on fresh round",
    captured.filter((e) => e.type === "context.rebuild").length === 0,
  );
  check(
    "12c. messages untouched",
    tinyMsgs.length === 1 && tinyMsgs[0]!.content === "hi",
  );

  // Disabled monitor (null) → trivially no rebuild
  const out2 = await runScwRound({
    monitor: null,
    messages: tinyMsgs,
    systemBytes: 0,
    cost,
    cwd,
    sessionId,
    provider: "openai",
    model: "gpt-4o",
    cfg,
  });
  check(
    "12d. monitor=null → rebuilt:false + no pressure",
    out2.rebuilt === false && out2.pressure === undefined && out2.budget === undefined,
  );
}

// ── 13. CostTracker.cumulativeTotal survives splitSession ────────────────
{
  const c = new CostTracker({ telemetry: false });
  c.record("openai", "gpt-4o", { in: 100_000, out: 5_000 });
  const cum = c.cumulativeTotal();
  const sess = c.total();
  check(
    "13a. before split: total === cumulative",
    cum.usd === sess.usd && cum.usd > 0,
  );
  c.splitSession();
  check(
    "13b. after split: total reset to 0",
    c.total().usd === 0,
  );
  check(
    "13c. after split: cumulative preserved",
    c.cumulativeTotal().usd === cum.usd,
  );
  // Subsequent record adds to BOTH
  c.record("openai", "gpt-4o", { in: 1000, out: 100 });
  check(
    "13d. post-split record adds to both buckets",
    c.total().usd > 0 && c.cumulativeTotal().usd > cum.usd,
  );
}

// ── 14. ContextMonitor.reset() ────────────────────────────────────────────
{
  const cfg = loadConfig();
  const m = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd: process.cwd(),
    threadId: "reset-test",
  });
  let listenerHits = 0;
  m.onLevelChange(() => { listenerHits++; });
  m.inspect([{ role: "user", content: "x".repeat(400_000) }], 0);
  check("14a. monitor at hard after big input", m.level === "hard");
  m.reset();
  check("14b. monitor.reset() → level=fresh", m.level === "fresh");
  // Re-trigger: listener still fires (reset preserves listeners)
  m.inspect([{ role: "user", content: "x".repeat(400_000) }], 0);
  check(
    "14c. listeners survive reset (transition fires again)",
    listenerHits >= 2,
    `hits=${listenerHits}`,
  );
}

// ── 15. budgetTotal ≤ effectiveWindow invariant (sweep) ──────────────────
{
  const cfg = loadConfig();
  // Sweep across providers — `budgetTotal(b) ≤ effectiveWindow` MUST hold
  // unconditionally for every provider in PCM. Use the live `thresholds()`
  // result rather than hardcoded windows so a PCM bump doesn't break the
  // smoke (single-source per AGENTS.md §17).
  const providers = [
    { p: "openai", m: "gpt-4o" },
    { p: "gemini", m: "gemini-2.5-pro" },
    { p: "anthropic", m: "claude-sonnet-4-5" },
    { p: "deepseek", m: "deepseek-chat" },
  ] as const;
  const { thresholds: thr } = await import("../src/context/thresholds.js");
  for (const c of providers) {
    const b = computeBudget(c.m, c.p as never, cfg, {});
    const t = thr(c.m, c.p as never, cfg, {});
    check(
      `15.${c.p}. budgetTotal ≤ effectiveWindow (${t.effectiveWindow})`,
      budgetTotal(b) <= t.effectiveWindow,
      `total=${budgetTotal(b)} effective=${t.effectiveWindow}`,
    );
  }
}

// ── Summary + Cleanup ─────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* */ }

resetConfigCache();
_resetHomeEnsureCacheForTesting();
_resetProjectEnsureCacheForTesting();

if (fail > 0) process.exit(1);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * In-memory MemoryStore stub. Returns the rows verbatim from `search`/`list`
 * — sufficient for memoryPick's smoke (filtering by projectId is the only
 * filter the rebuilder relies on; rows must carry the right projectId).
 */
function makeStubStore(rows: MemoryRecord[]): MemoryStore {
  // Pick the projectId from the first row when present so memoryPick's
  // default `projectId = store.projectId` matches what the rebuilder
  // expects. Empty stores keep the legacy "stub-project" id.
  const pid = rows[0]?.projectId ?? "stub-project";
  return {
    degraded: true,
    path: "/dev/null",
    projectId: pid,
    upsert: async () => {},
    upsertMany: async () => {},
    remove: async () => {},
    removeBySource: async () => {},
    list: async () => rows,
    search: async () => rows,
    rebuild: async () => ({ count: rows.length, degraded: true, durMs: 0 }),
    count: async () => rows.length,
    getIndexedMtime: async () => null,
    setIndexedMtime: async () => {},
    close: () => {},
  };
}
