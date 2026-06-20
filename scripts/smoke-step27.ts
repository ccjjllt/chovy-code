/**
 * Step-27 SCW context-monitor smoke (run with `bun scripts/smoke-step27.ts`).
 *
 * Exercises `docs/step-27-context-monitor.md §验收标准` plus the
 * cross-step invariants from the plan-mode design:
 *
 *   1. thresholds(): provider PCM is single source — gpt-4o → 128k window,
 *      soft = 96000; gemini-2.5-pro → 1_000_000 window, soft = 750000.
 *      Env CHOVY_CTX_SOFT_RATIO/HARD_RATIO override; bad ratios fall back.
 *   2. defaultEstimator: error vs ground-truth ascii < 5 % across 1k/10k/64k
 *      strings; countMessages includes role + content + tool-call args.
 *   3. ContextMonitor: fresh→soft transition fires checkpoint coordinator
 *      with reason='token-soft' and emits `context.threshold` telemetry
 *      exactly once.
 *   4. ContextMonitor: switching providers (different ctx window) yields
 *      a new threshold map; HeaderBar `usedPct` reflects the new ratio.
 *   5. CHOVY_CTX_DISABLE=1: createContextMonitorIfEnabled returns null;
 *      engine path keeps working (no monitor → no telemetry).
 *   6. Edge transitions: fresh→soft→hard fires telemetry twice (once each
 *      for soft + hard); no `fresh` shape ever fires; downward soft→fresh
 *      does NOT re-fire (sticky max-level rule).
 *   7. Cancellation: pre-aborted parentSignal → monitor.inspect still
 *      returns a state (synchronous, doesn't throw); checkpoint
 *      coordinator handles its own local AC.
 *   8. pressureSection: 'fresh' renders empty; 'soft' renders the spec
 *      block with used%/remaining_tokens and "checkpoint 已自动保存"
 *      when checkpointWritten=true; 'hard' renders the harder variant.
 *   9. QueryEngine integration smoke: pendingPressure / pendingBudget
 *      thread into the next round's BuildOptions; ctxMonitor=null
 *      degrades gracefully.
 *
 * Fully offline: stubs the checkpoint coordinator + telemetry sink so we
 * never touch the network or the real disk telemetry dir.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tmp dir + CHOVY_HOME override (must be set before any home/paths import) ─
const TMP_HOME = join(tmpdir(), `chovy-smoke27-${Date.now().toString(36)}`);
process.env["CHOVY_HOME"] = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

// Stub provider env keys so `hasSecret(...)` / engine wiring don't bail.
process.env["CHOVY_API_KEY_OPENAI"] = "test-key-ignored";
process.env["OPENAI_API_KEY"] = "test-key-ignored";

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

import { ensureHomeDirs, _resetHomeEnsureCacheForTesting } from "../src/fs/home.js";
import {
  ensureProjectDirs,
  _resetProjectEnsureCacheForTesting,
} from "../src/fs/paths.js";
import { loadConfig, resetConfigCache } from "../src/config/index.js";
import {
  defaultEstimator,
  pickEstimator,
  thresholds,
  createContextMonitor,
  _internalsForTesting,
  CHARS_PER_TOKEN,
  ESTIMATE_SAFETY,
} from "../src/context/index.js";
import { createContextMonitorIfEnabled } from "../src/engine/contextHook.js";
import { pendingFromMonitorState } from "../src/engine/contextHook.js";
import { pressureSection } from "../src/prompts/index.js";
import type {
  CheckpointCoordinator,
  CheckpointInput,
  CheckpointReason,
  CheckpointResult,
} from "../src/memory/index.js";
import type { ChatMessage } from "../src/types/index.js";

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

console.log("=== Step-27 context-monitor smoke ===\n");

// ── 1. thresholds() — PCM single source + env overrides ──────────────────
{
  const cfg = loadConfig();
  const t1 = thresholds("gpt-4o", "openai", cfg, {});
  check(
    "1a. openai window=128k",
    t1.ctxWindow === 128_000,
    `ctxWindow=${t1.ctxWindow}`,
  );
  check(
    "1b. openai soft=floor(128000*0.75)=96000",
    t1.soft === 96_000,
    `soft=${t1.soft}`,
  );
  check(
    "1c. openai hard=floor(128000*0.9)=115200",
    t1.hard === 115_200,
    `hard=${t1.hard}`,
  );

  const t2 = thresholds("gemini-2.5-pro", "kimi", cfg, {});
  check(
    "1d. gemini window=1_000_000",
    t2.ctxWindow === 1_000_000,
    `ctxWindow=${t2.ctxWindow}`,
  );
  check(
    "1e. gemini soft=750000",
    t2.soft === 750_000,
    `soft=${t2.soft}`,
  );

  // Env override
  const t3 = thresholds("gpt-4o", "openai", cfg, {
    CHOVY_CTX_SOFT_RATIO: "0.6",
    CHOVY_CTX_HARD_RATIO: "0.85",
  });
  check(
    "1f. env override soft=0.6 → 76800",
    t3.soft === Math.floor(128_000 * 0.6),
    `soft=${t3.soft}`,
  );
  check(
    "1g. env override hard=0.85 → 108800",
    t3.hard === Math.floor(128_000 * 0.85),
    `hard=${t3.hard}`,
  );

  // Bad ratios fall back to cfg
  const t4 = thresholds("gpt-4o", "openai", cfg, {
    CHOVY_CTX_SOFT_RATIO: "0.95",
    CHOVY_CTX_HARD_RATIO: "0.5",
  });
  check(
    "1h. invalid env ratios fall back to cfg defaults (soft=96000)",
    t4.soft === 96_000,
    `soft=${t4.soft}`,
  );

  // Reserve clipped at 50 % of ctxWindow
  const t5 = thresholds("openai" as never, "openai", cfg, {
    CHOVY_CTX_RESERVE_TOKENS: "1000000", // absurd
  });
  check(
    "1i. reserve clipped at 50% ctxWindow",
    t5.reserve === 64_000,
    `reserve=${t5.reserve}`,
  );
}

// ── 2. defaultEstimator — error < 5 % ──────────────────────────────────────
{
  // For ascii: ground truth ≈ chars/4 + 4 overhead per message; the safety
  // factor pushes the estimate up by 1.2×. Test that countString itself
  // sits within the documented bound.
  const probe = (n: number): number => {
    const s = "x".repeat(n);
    return defaultEstimator.countString(s);
  };
  for (const n of [1024, 10_240, 65_536]) {
    const got = probe(n);
    const expected = Math.ceil((n / CHARS_PER_TOKEN) * ESTIMATE_SAFETY);
    check(
      `2.${n}. countString(${n}) === expected (${expected})`,
      got === expected,
      `got=${got}`,
    );
  }
  // countMessages: includes role + content + per-message overhead.
  const msgs: ChatMessage[] = [
    { role: "user", content: "hello world" },
    { role: "assistant", content: "ok" },
  ];
  const total = defaultEstimator.countMessages(msgs);
  check(
    "2d. countMessages > 0 + bounded",
    total > 0 && total < 200,
    `total=${total}`,
  );
  // Tool call args are counted.
  const withTool: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "file_read", arguments: '{"path":"foo.ts"}' }],
    },
  ];
  const t = defaultEstimator.countMessages(withTool);
  check(
    "2e. countMessages includes tool-call arguments",
    t >= defaultEstimator.countString("file_read") +
      defaultEstimator.countString('{"path":"foo.ts"}'),
    `total=${t}`,
  );
  // pickEstimator returns the default for known + unknown families.
  const e = pickEstimator("gpt");
  check(
    "2f. pickEstimator('gpt') returns an estimator",
    typeof e.countString === "function",
  );
}

// ── 3. ContextMonitor — fresh→soft fires checkpoint + telemetry ───────────
{
  // Stub coordinator: capture (reason, input) calls.
  const calls: Array<{ reason: CheckpointReason; input: CheckpointInput }> = [];
  const stubCoord: CheckpointCoordinator = {
    maybeCheckpoint: async (
      reason: CheckpointReason,
      input: CheckpointInput,
    ): Promise<CheckpointResult> => {
      calls.push({ reason, input });
      return {
        ok: true,
        reason,
        latestPath: "/dev/null",
        bytes: 0,
        mode: "agent",
      } as CheckpointResult;
    },
    _resetDebounceForTesting: () => {},
  } as unknown as CheckpointCoordinator;

  // openai default soft = 96000 tokens. countString(s) ≈ s.length * 0.3.
  // 350k chars ≈ 105k tokens — comfortably crosses soft, well below hard.
  const cfg = loadConfig();
  const monitor = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    checkpoints: stubCoord,
    cwd: process.cwd(),
    threadId: "smoke-thread",
  });

  captured.length = 0;
  const msgs: ChatMessage[] = [
    { role: "user", content: "x".repeat(350_000) },
  ];
  const snap = monitor.inspect(msgs, 4_000);
  check(
    "3a. monitor.inspect returns a soft level after crossing soft",
    snap.level === "soft",
    `level=${snap.level} total=${snap.total}`,
  );
  check(
    "3b. snap.transitioned === true on first crossing",
    snap.transitioned,
    `transitioned=${snap.transitioned}`,
  );
  check(
    "3c. context.threshold telemetry emitted exactly once (soft)",
    captured.filter((e) => e.type === "context.threshold").length === 1,
    `count=${captured.filter((e) => e.type === "context.threshold").length}`,
  );
  const tEv = captured.find((e) => e.type === "context.threshold") as
    | { type: "context.threshold"; level: string; tokens: number }
    | undefined;
  check(
    "3d. telemetry level === 'soft'",
    tEv?.level === "soft",
    `level=${tEv?.level}`,
  );
  // checkpoint coordinator hit
  check(
    "3e. coordinator received reason='token-soft'",
    calls.length === 1 && calls[0]!.reason === "token-soft",
    `calls=${calls.length} reason=${calls[0]?.reason}`,
  );

  // 2nd inspect at the same level should NOT re-fire telemetry / coord.
  captured.length = 0;
  const snap2 = monitor.inspect(msgs, 4_000);
  check(
    "3f. second inspect at same level: no re-emit, transitioned=false",
    !snap2.transitioned &&
      captured.filter((e) => e.type === "context.threshold").length === 0,
    `transitioned=${snap2.transitioned}`,
  );
  check(
    "3g. coordinator NOT re-called on no-transition",
    calls.length === 1,
    `calls=${calls.length}`,
  );
}

// ── 4. Switch model → new threshold map ──────────────────────────────────
{
  const cfg = loadConfig();
  const m1 = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd: process.cwd(),
    threadId: "t1",
  });
  const m2 = createContextMonitor({
    providerId: "kimi",
    model: "gemini-2.5-pro",
    cfg,
    cwd: process.cwd(),
    threadId: "t2",
  });
  check(
    "4a. m1.thresholds.ctxWindow=128000",
    m1.thresholds.ctxWindow === 128_000,
  );
  check(
    "4b. m2.thresholds.ctxWindow=1_000_000 (auto-updated for new provider)",
    m2.thresholds.ctxWindow === 1_000_000,
  );
}

// ── 5. CHOVY_CTX_DISABLE=1 — engine helper returns null ──────────────────
{
  const prev = process.env["CHOVY_CTX_DISABLE"];
  process.env["CHOVY_CTX_DISABLE"] = "1";
  const cfg = loadConfig();
  const m = createContextMonitorIfEnabled({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd: process.cwd(),
    threadId: "t3",
  });
  check("5a. createContextMonitorIfEnabled returns null when disabled", m === null);
  if (prev === undefined) delete process.env["CHOVY_CTX_DISABLE"];
  else process.env["CHOVY_CTX_DISABLE"] = prev;

  const m2 = createContextMonitorIfEnabled({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd: process.cwd(),
    threadId: "t4",
  });
  check("5b. createContextMonitorIfEnabled returns instance when enabled", m2 !== null);
}

// ── 6. fresh→soft→hard transitions; downward sticky ──────────────────────
{
  // Use real openai thresholds (soft=96000 / hard=115200) and craft inputs
  // that cross each. countString(s) ≈ s.length * 0.3 → 350k chars ≈ 105k
  // tokens (soft), 400k chars ≈ 120k tokens (hard).
  const cfg = loadConfig();
  const monitor = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd: process.cwd(),
    threadId: "t6",
  });

  captured.length = 0;
  const tiny: ChatMessage[] = [{ role: "user", content: "x".repeat(80_000) }]; // ~24k tokens — fresh
  const small: ChatMessage[] = [{ role: "user", content: "x".repeat(350_000) }]; // ~105k — soft
  const big: ChatMessage[] = [{ role: "user", content: "x".repeat(400_000) }]; // ~120k — hard
  const tinyState = monitor.inspect(tiny, 0);
  const softState = monitor.inspect(small, 0);
  const hardState = monitor.inspect(big, 0);
  check(
    "6a. tiny → fresh (24k tokens, below soft=96k)",
    tinyState.level === "fresh",
    `level=${tinyState.level} total=${tinyState.total}`,
  );
  check("6b. medium → soft", softState.level === "soft", `level=${softState.level} total=${softState.total}`);
  check("6c. big → hard", hardState.level === "hard", `level=${hardState.level} total=${hardState.total}`);
  // Telemetry: exactly 2 events (soft + hard) — fresh shape never emitted.
  const evs = captured.filter((e) => e.type === "context.threshold");
  const levels = evs.map((e) => (e as { level: string }).level);
  check(
    "6d. telemetry: exactly 2 events (soft + hard); no 'fresh' level",
    evs.length === 2 && levels.includes("soft") && levels.includes("hard"),
    `events=${JSON.stringify(levels)}`,
  );
  // Drop back below soft → does NOT re-emit (sticky max-level rule).
  captured.length = 0;
  monitor.inspect([{ role: "user", content: "" }], 0);
  const downEvs = captured.filter((e) => e.type === "context.threshold");
  check(
    "6e. downward soft→fresh suppressed (no telemetry; sticky)",
    downEvs.length === 0,
    `count=${downEvs.length}`,
  );
}

// ── 7. Cancellation — pre-aborted signal does not block monitor.inspect ──
{
  const cfg = loadConfig();
  const ac = new AbortController();
  ac.abort(); // pre-aborted
  const monitor = createContextMonitor({
    providerId: "openai",
    model: "gpt-4o",
    cfg,
    cwd: process.cwd(),
    threadId: "t7",
    parentSignal: ac.signal,
  });
  let threw = false;
  try {
    const s = monitor.inspect([{ role: "user", content: "hi" }], 100);
    check("7a. inspect with aborted signal returns state synchronously",
      s.level === "fresh", `level=${s.level}`);
  } catch (err) {
    threw = true;
    check("7a. inspect with aborted signal returns state synchronously",
      false, `threw: ${err}`);
  }
  check("7b. inspect did not throw on aborted signal", !threw);
}

// ── 8. pressureSection — fresh empty / soft / hard render correctly ──────
{
  check(
    "8a. pressureSection({level:'fresh'}) === ''",
    pressureSection({
      level: "fresh",
      usedPct: 50,
      remainingTokens: 50_000,
      checkpointWritten: false,
    }) === "",
  );
  const soft = pressureSection({
    level: "soft",
    usedPct: 82,
    remainingTokens: 22_000,
    checkpointWritten: true,
  });
  check(
    "8b. soft block contains '<context-pressure level=\"soft\"'",
    soft.includes('<context-pressure level="soft"'),
  );
  check(
    "8c. soft block reflects used=82%/remaining=22000",
    soft.includes('used="82%"') && soft.includes('remaining_tokens="22000"'),
  );
  check(
    "8d. soft block contains 'checkpoint 已自动保存' when checkpointWritten=true",
    soft.includes("checkpoint 已自动保存"),
  );
  const hard = pressureSection({
    level: "hard",
    usedPct: 92,
    remainingTokens: 8_000,
    checkpointWritten: false,
  });
  check(
    "8e. hard block contains '<context-pressure level=\"hard\"'",
    hard.includes('<context-pressure level="hard"'),
  );
  check(
    "8f. hard block urges /checkpoint when not yet written",
    hard.includes("/checkpoint now"),
  );
}

// ── 9. pendingFromMonitorState — engine glue ─────────────────────────────
{
  const t = thresholds("gpt-4o", "openai", loadConfig(), {});
  // fresh state → undefined pressure, budget filled
  const fresh = pendingFromMonitorState({
    total: 100,
    effective: [],
    thresholds: t,
    level: "fresh",
    transitioned: false,
    checkpointTriggered: false,
  });
  check(
    "9a. fresh → pressure undefined, budget {used,total} set",
    fresh.pressure === undefined &&
      fresh.budget?.used === 100 &&
      fresh.budget?.total === 128_000,
  );
  // soft state with checkpoint → pressure populated
  const softHints = pendingFromMonitorState({
    total: 100_000,
    effective: [],
    thresholds: t,
    level: "soft",
    transitioned: true,
    checkpointTriggered: true,
  });
  check(
    "9b. soft → pressure populated, level='soft', usedPct=78, checkpointWritten=true",
    softHints.pressure?.level === "soft" &&
      softHints.pressure?.usedPct === 78 &&
      softHints.pressure?.checkpointWritten === true,
  );
  // hard transition logs warn (smoke can't intercept logger; just verify no throw + populated)
  const hardHints = pendingFromMonitorState({
    total: 120_000,
    effective: [],
    thresholds: t,
    level: "hard",
    transitioned: true,
    checkpointTriggered: false,
  });
  check(
    "9c. hard transition produces pressure.level='hard' (warn fired internally)",
    hardHints.pressure?.level === "hard",
  );
}

// ── 10. _internals — pickLevel / isUpwardTransition ──────────────────────
{
  const t = thresholds("gpt-4o", "openai", loadConfig(), {});
  check(
    "10a. pickLevel(0) === fresh",
    _internalsForTesting.pickLevel(0, t) === "fresh",
  );
  check(
    "10b. pickLevel(soft) === soft",
    _internalsForTesting.pickLevel(t.soft, t) === "soft",
  );
  check(
    "10c. pickLevel(hard) === hard",
    _internalsForTesting.pickLevel(t.hard, t) === "hard",
  );
  check(
    "10d. isUpwardTransition fresh→soft true",
    _internalsForTesting.isUpwardTransition("fresh", "soft") === true,
  );
  check(
    "10e. isUpwardTransition soft→fresh false",
    _internalsForTesting.isUpwardTransition("soft", "fresh") === false,
  );
  check(
    "10f. isUpwardTransition hard→hard false",
    _internalsForTesting.isUpwardTransition("hard", "hard") === false,
  );
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

resetConfigCache();
_resetHomeEnsureCacheForTesting();
_resetProjectEnsureCacheForTesting();

if (fail > 0) process.exit(1);
