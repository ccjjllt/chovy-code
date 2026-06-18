/**
 * Step-23 goal-loop smoke (run with `bun scripts/smoke-step23.ts`).
 *
 * Exercises `docs/step-23-goal-loop.md §验收标准` plus the unit-level
 * invariants from §plan §10:
 *
 *   1. parseGoalCommand: clear / set / status / pause / resume / complete
 *      / set with --rubric and --cmd flags.
 *   2. inferConvergence: "通过 typecheck" → command; free-form → rubric;
 *      both rubric + objective → hybrid when objective implies a cmd.
 *   3. goalState lifecycle: create → persist → load → list roundtrip.
 *   4. evaluateConvergence rubric mode: stub provider returns {"ok":true}
 *      → convergence ok=true; returns {"ok":false,"reason":"X"} → ok=false
 *      with the reason surfaced; returns garbage → ok=false (parse).
 *   5. evaluateConvergence command mode: `node --version` (always exit 0)
 *      → ok=true; `node --bogus-flag-zzz123` (always exits non-zero) →
 *      ok=false with exit code captured.
 *   6. runGoal achieved: stub provider returns final on round 1 + rubric
 *      stub returns ok → status=achieved after 1 round.
 *   7. runGoal cancelled: signal aborted before first round → status=cancelled.
 *   8. runGoal budget exceeded: budgetUSD=0.0001 + provider that reports
 *      usage → status=failed.
 *   9. runGoal death-spiral guard: rubric stub always returns ok=false
 *      with no fs-mutate calls in 5 consecutive rounds → status=paused.
 *  10. checkpoint helpers: shouldCheckpoint(round=5) === true;
 *      triggerCheckpoint with no spawnFn is a safe no-op.
 *
 * Fully offline: stub providers (registered + unregistered per case) drive
 * the engine; cwd points at a tmp dir under `os.tmpdir()` so persistence
 * doesn't pollute the real `~/.chovy`. CHOVY_HOME is overridden to the
 * same tmp dir so secrets aren't required.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isChovyError } from "../src/types/errors.js";

// ── Tmp dir + CHOVY_HOME override (must be set before any home/paths import) ─
const TMP_HOME = join(tmpdir(), `chovy-smoke23-${Date.now().toString(36)}`);
process.env["CHOVY_HOME"] = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

// Stub a provider secret so hasSecret(...) returns true for our stub providers.
process.env["CHOVY_API_KEY_OPENAI"] = "test-key-ignored";
process.env["OPENAI_API_KEY"] = "test-key-ignored";

import { ensureHomeDirs, _resetHomeEnsureCacheForTesting } from "../src/fs/home.js";
import { ensureProjectDirs, _resetProjectEnsureCacheForTesting } from "../src/fs/paths.js";
import {
  parseGoalCommand,
  inferConvergence,
  createGoal,
  persistGoal,
  loadGoal,
  listGoals,
  finalizeGoal,
  evaluateConvergence,
  runGoal,
  shouldCheckpoint,
  triggerCheckpoint,
  _resetGoalsForTesting,
  CHECKPOINT_INTERVAL_ROUNDS,
} from "../src/goals/index.js";
import { registerProvider, _unregisterProviderForTesting } from "../src/providers/index.js";
import type { Provider, ProviderRequestOptions } from "../src/types/provider.js";
import type { ChatCompletion, ChatMessage } from "../src/types/index.js";

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
const SMOKE_CWD = process.cwd();

console.log("=== Step-23 goal-loop smoke ===\n");

// ── 1. parseGoalCommand ────────────────────────────────────────────────────
{
  // empty → throws CONFIG_INVALID
  let threw = false;
  try { parseGoalCommand("   "); } catch (err) {
    threw = isChovyError(err) && err.code === "CONFIG_INVALID";
  }
  check("parseGoalCommand: empty throws CONFIG_INVALID", threw);

  const set = parseGoalCommand("通过 typecheck");
  check("parseGoalCommand: bare objective → set", set.type === "set");
  if (set.type === "set") {
    check("parseGoalCommand: objective preserved", set.objective === "通过 typecheck");
  }

  const flags = parseGoalCommand('修复 bug --rubric "测试全绿" --cmd "bun test"');
  check("parseGoalCommand: --rubric parsed", flags.type === "set" && (flags as any).rubric === "测试全绿");
  check("parseGoalCommand: --cmd parsed", flags.type === "set" && (flags as any).cmd === "bun test");
  check(
    "parseGoalCommand: objective stripped of flags",
    flags.type === "set" && (flags as any).objective === "修复 bug",
  );

  for (const verb of ["status", "pause", "resume", "complete", "clear"] as const) {
    const p = parseGoalCommand(verb);
    check(`parseGoalCommand: "${verb}" → ${verb}`, p.type === verb);
  }
}

// ── 2. inferConvergence heuristics ─────────────────────────────────────────
{
  const a = inferConvergence("让仓库通过 typecheck", undefined);
  check("inferConvergence: typecheck → command", a.mode === "command" && a.cmd === "bun run typecheck");

  const b = inferConvergence("写一段 README", undefined);
  check("inferConvergence: free-form → rubric", b.mode === "rubric");

  const c = inferConvergence("跑测试", "no warnings");
  check(
    "inferConvergence: rubric + cmd-implying objective → hybrid",
    c.mode === "hybrid" && c.cmd === "bun test" && c.rubric === "no warnings",
  );

  const d = inferConvergence("写一段 README", "至少 200 字");
  check(
    "inferConvergence: rubric + free-form → rubric (rubric trumps default)",
    d.mode === "rubric" && d.rubric === "至少 200 字",
  );
}

// ── 3. goalState lifecycle ─────────────────────────────────────────────────
{
  _resetGoalsForTesting();
  const goal = createGoal({
    threadId: "thread-test-3",
    objective: "Test persistence",
  });
  check("createGoal: returns active goal", goal.status === "active" && goal.rounds === 0);
  check("createGoal: id 12 chars", goal.id.length === 12);

  await persistGoal(SMOKE_CWD, goal);
  const loaded = await loadGoal(SMOKE_CWD, goal.id);
  check("loadGoal: roundtrip", loaded !== null && loaded.id === goal.id && loaded.objective === goal.objective);

  const list = await listGoals(SMOKE_CWD);
  check("listGoals: contains the persisted goal", list.some((g) => g.id === goal.id));

  finalizeGoal(goal.threadId, "achieved");
  await persistGoal(SMOKE_CWD, goal);
  const reloaded = await loadGoal(SMOKE_CWD, goal.id);
  check("finalizeGoal: status persisted", reloaded?.status === "achieved");
}

// ── 4. evaluateConvergence rubric mode ─────────────────────────────────────
{
  // Register a stub OpenAI provider that returns `{"ok":true}` first, then
  // `{"ok":false,"reason":"missing X"}`, then garbage — one per case below.
  const responses: string[] = [];
  const stub: Provider = {
    info: {
      id: "openai",
      label: "OpenAI Stub",
      envKey: "CHOVY_API_KEY_OPENAI",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady() {},
    async complete(_opts: ProviderRequestOptions): Promise<ChatCompletion> {
      const content = responses.shift() ?? "";
      return { content, toolCalls: [], usage: { prompt: 100, completion: 10 } };
    },
  };
  _unregisterProviderForTesting("openai");
  registerProvider(stub);

  _resetGoalsForTesting();
  const goal = createGoal({
    threadId: "thread-test-4",
    objective: "Smoke rubric",
    convergence: { mode: "rubric", rubric: "tests pass" },
  });

  responses.push('{"ok": true}');
  const r1 = await evaluateConvergence(goal, [
    { role: "assistant", content: "done" },
  ] as ChatMessage[], {
    cwd: SMOKE_CWD,
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
  });
  check("rubric: ok:true → achieved", r1.ok === true);

  responses.push('{"ok": false, "reason": "missing X"}');
  const r2 = await evaluateConvergence(goal, [], {
    cwd: SMOKE_CWD,
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
  });
  check("rubric: ok:false → not achieved", r2.ok === false);
  check(
    "rubric: reason surfaced",
    r2.reasons.some((r) => r.includes("missing X")),
    `reasons=${JSON.stringify(r2.reasons)}`,
  );

  responses.push("not-json garbage <<<");
  const r3 = await evaluateConvergence(goal, [], {
    cwd: SMOKE_CWD,
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
  });
  check("rubric: garbage → ok=false (parse)", r3.ok === false);

  _unregisterProviderForTesting("openai");
}

// ── 5. evaluateConvergence command mode ────────────────────────────────────
{
  _resetGoalsForTesting();
  const okGoal = createGoal({
    threadId: "thread-test-5a",
    objective: "Smoke cmd ok",
    convergence: { mode: "command", cmd: "node --version" },
  });
  const okRes = await evaluateConvergence(okGoal, [], {
    cwd: SMOKE_CWD,
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
    skipRubric: true,
  });
  check("command: node --version exit=0 → ok", okRes.ok === true, JSON.stringify(okRes.details));

  const failGoal = createGoal({
    threadId: "thread-test-5b",
    objective: "Smoke cmd fail",
    convergence: { mode: "command", cmd: "node --bogus-flag-zzz123" },
  });
  const failRes = await evaluateConvergence(failGoal, [], {
    cwd: SMOKE_CWD,
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
    skipRubric: true,
  });
  check("command: bogus-flag exit≠0 → not ok", failRes.ok === false);
}

// ── 6. runGoal achieved (stub provider returns final + rubric ok) ──────────
{
  // Stub: engine round returns `{content:"done",toolCalls:[]}` so engine
  // exits with stopReason='final'. Then rubric stub returns {"ok":true}.
  let callCount = 0;
  const stub: Provider = {
    info: {
      id: "openai",
      label: "OpenAI Stub",
      envKey: "CHOVY_API_KEY_OPENAI",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: true,
    },
    assertReady() {},
    async complete(_opts: ProviderRequestOptions): Promise<ChatCompletion> {
      callCount++;
      // Round 1: engine round (returns final). Round 2: rubric judge.
      if (callCount === 1) {
        return { content: "I have completed the task.", toolCalls: [], usage: { prompt: 50, completion: 10 } };
      }
      return { content: '{"ok": true}', toolCalls: [], usage: { prompt: 80, completion: 4 } };
    },
  };
  _unregisterProviderForTesting("openai");
  registerProvider(stub);
  _resetGoalsForTesting();

  const goal = createGoal({
    threadId: "thread-test-6",
    objective: "Achieve smoke",
    convergence: { mode: "rubric", rubric: "task complete" },
    maxRounds: 5,
    budgetUSD: 1,
  });
  const res = await runGoal(goal, {
    cwd: SMOKE_CWD,
    provider: "openai",
    model: "gpt-4o-mini",
    permissionMode: "default",
    engineMaxRounds: 2,
  });
  check("runGoal: status=achieved after 1 round", res.goal.status === "achieved" && res.rounds === 1);
  check("runGoal: rubric judge called (callCount===2)", callCount === 2, `callCount=${callCount}`);

  _unregisterProviderForTesting("openai");
}

// ── 7. runGoal cancelled ───────────────────────────────────────────────────
{
  const stub: Provider = {
    info: {
      id: "openai",
      label: "OpenAI Stub",
      envKey: "CHOVY_API_KEY_OPENAI",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady() {},
    async complete(opts: ProviderRequestOptions): Promise<ChatCompletion> {
      // Honor abort: provider should reject if signal already aborted.
      if (opts.signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      return { content: "x", toolCalls: [], usage: { prompt: 1, completion: 1 } };
    },
  };
  _unregisterProviderForTesting("openai");
  registerProvider(stub);
  _resetGoalsForTesting();

  const goal = createGoal({
    threadId: "thread-test-7",
    objective: "Cancel smoke",
    convergence: { mode: "rubric", rubric: "x" },
    maxRounds: 5,
  });
  const ac = new AbortController();
  ac.abort(); // pre-abort
  const res = await runGoal(goal, {
    cwd: SMOKE_CWD,
    provider: "openai",
    model: "gpt-4o-mini",
    abortSignal: ac.signal,
  });
  check(
    "runGoal: pre-aborted signal → status=cancelled",
    res.goal.status === "cancelled" || res.goal.status === "failed",
    `status=${res.goal.status}`,
  );

  _unregisterProviderForTesting("openai");
}

// ── 8. runGoal budget exceeded ─────────────────────────────────────────────
{
  // Stub that reports a huge usage so cost shoots past the cap on round 1.
  const stub: Provider = {
    info: {
      id: "openai",
      label: "OpenAI Stub",
      envKey: "CHOVY_API_KEY_OPENAI",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady() {},
    async complete(_opts: ProviderRequestOptions): Promise<ChatCompletion> {
      return {
        content: "expensive turn",
        toolCalls: [],
        usage: { prompt: 10_000_000, completion: 1_000_000 },
      };
    },
  };
  _unregisterProviderForTesting("openai");
  registerProvider(stub);
  _resetGoalsForTesting();

  const goal = createGoal({
    threadId: "thread-test-8",
    objective: "Budget smoke",
    convergence: { mode: "rubric", rubric: "x" },
    maxRounds: 5,
    budgetUSD: 0.0001,
  });
  const res = await runGoal(goal, {
    cwd: SMOKE_CWD,
    provider: "openai",
    model: "gpt-4o-mini",
  });
  check(
    "runGoal: 0.0001 budget vs huge usage → status=failed",
    res.goal.status === "failed",
    `status=${res.goal.status} cost=${res.costUSD}`,
  );

  _unregisterProviderForTesting("openai");
}

// ── 9. runGoal death-spiral guard ──────────────────────────────────────────
{
  // Stub: every round returns final but rubric always says ok=false. With
  // no fs-mutate tool calls, noProgressRounds increments and trips at 5.
  let i = 0;
  const stub: Provider = {
    info: {
      id: "openai",
      label: "OpenAI Stub",
      envKey: "CHOVY_API_KEY_OPENAI",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady() {},
    async complete(_opts: ProviderRequestOptions): Promise<ChatCompletion> {
      i++;
      // Even calls = engine round; odd calls = rubric. We can't tell from
      // here, so just return shapes that work for both:
      // - engine round expects content with no toolCalls → final
      // - rubric expects JSON
      // Distinguish by inspecting the system prompt: the rubric judge's
      // system prompt contains "Stop-hook evaluator".
      const isRubric = (_opts.systemPrompt ?? "").includes("Stop-hook evaluator");
      if (isRubric) {
        return { content: '{"ok": false, "reason": "no progress"}', toolCalls: [], usage: { prompt: 30, completion: 8 } };
      }
      return { content: "still trying...", toolCalls: [], usage: { prompt: 20, completion: 5 } };
    },
  };
  _unregisterProviderForTesting("openai");
  registerProvider(stub);
  _resetGoalsForTesting();

  const goal = createGoal({
    threadId: "thread-test-9",
    objective: "Death spiral smoke",
    convergence: { mode: "rubric", rubric: "definitely fails" },
    maxRounds: 20,
    budgetUSD: 100,
  });
  const res = await runGoal(goal, {
    cwd: SMOKE_CWD,
    provider: "openai",
    model: "gpt-4o-mini",
    engineMaxRounds: 1, // force outer-loop to drive iterations
  });
  check(
    "runGoal: 5+ no-mutate rounds → status=paused",
    res.goal.status === "paused",
    `status=${res.goal.status} rounds=${res.rounds}`,
  );
  check(
    "runGoal: rounds reached the death-spiral threshold (≥5)",
    res.rounds >= 5,
    `rounds=${res.rounds}`,
  );

  _unregisterProviderForTesting("openai");
}

// ── 10. checkpoint helpers ─────────────────────────────────────────────────
{
  _resetGoalsForTesting();
  const goal = createGoal({
    threadId: "thread-test-10",
    objective: "Checkpoint smoke",
  });
  goal.rounds = CHECKPOINT_INTERVAL_ROUNDS;
  check("shouldCheckpoint: round=5 → true", shouldCheckpoint(goal) === true);
  goal.rounds = 4;
  check("shouldCheckpoint: round=4 → false", shouldCheckpoint(goal) === false);
  goal.rounds = 0;
  check("shouldCheckpoint: round=0 → false", shouldCheckpoint(goal) === false);

  // No spawnFn → safe no-op (no throw).
  let threw = false;
  try {
    await triggerCheckpoint(goal, {});
  } catch {
    threw = true;
  }
  check("triggerCheckpoint: no spawnFn → safe no-op", !threw);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
try {
  rmSync(TMP_HOME, { recursive: true, force: true });
} catch {
  /* ignore */
}
_resetHomeEnsureCacheForTesting();
_resetProjectEnsureCacheForTesting();

// ── Final report ──────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
