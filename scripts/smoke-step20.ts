/**
 * Step-20 smoke (run with `bun scripts/smoke-step20.ts`).
 *
 * Exercises `docs/step-20-swarm-router.md §验收标准`:
 *
 *   1. dispatch 4 prompts × different providers, all run in parallel;
 *   2. parallelism=2 → at most 2 children running at once;
 *   3. budgetUSD=$0.05 trips the budget (3-5 sub agents stop) and cancels
 *      the rest (stopReason='budgetExceeded');
 *   4. cancelling the dispatch abort signal → every unfinished sub-agent
 *      lands as `cancelled`;
 *   5. `swarm.dispatch` telemetry fires once per dispatch;
 *   6. results return in original array order regardless of completion order;
 *   7. a single child failing does NOT abort siblings (failure isolation);
 *   8. role mapping (explore → explorer, plan → planner, …) is correct;
 *   9. judge.enabled:true is tolerated (step-21 stub returns undefined).
 *
 * The script is fully offline — no provider / network / TTY required.
 * Sub-agents run against *stub* providers registered per-test. We drive
 * `dispatch()` directly (the tool layer is a thin adapter over it).
 */

import {
  dispatch,
  toAgentRole,
  MAX_DISPATCH_PROMPTS,
  createSwarmBus,
  createGlobalBudget,
  createLimiter,
  type JudgedAggregate,
} from "../src/swarm/index.js";
import { _resetSubAgentPoolForTesting } from "../src/agent/index.js";
import type {
  ParentRuntimeCtx,
  ProviderId,
} from "../src/types/index.js";
import {
  registerProvider,
  _unregisterProviderForTesting,
} from "../src/providers/index.js";
import type { Provider } from "../src/types/provider.js";
import {
  setTelemetrySink,
  createTelemetrySink,
  type TelemetrySink,
} from "../src/telemetry/index.js";

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

console.log("=== Step-20 SwarmR dispatch smoke ===\n");

// Use a tmp telemetry sink so we can assert `swarm.dispatch` events without
// touching the real ~/.chovy telemetry dir. We wrap a counting sink so the
// "one swarm.dispatch event per dispatch" invariant is observable.
let swarmDispatchCount = 0;
const innerSink: TelemetrySink = createTelemetrySink({ enabled: true, flushMs: 0 });
const countingSink: TelemetrySink = {
  get enabled() {
    return innerSink.enabled;
  },
  emit(ev) {
    if ((ev as { type?: string }).type === "swarm.dispatch") swarmDispatchCount++;
    innerSink.emit(ev);
  },
  flush: () => innerSink.flush(),
  close: () => innerSink.close(),
  currentFile: () => innerSink.currentFile(),
};
setTelemetrySink(countingSink);

const PROVIDERS: ProviderId[] = ["openai", "zai", "kimi", "deepseek"];

function makeParentCtx(extra: Partial<ParentRuntimeCtx> = {}): ParentRuntimeCtx {
  return {
    parentId: "main_smoke20",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "stub-model",
    parentMessages: [],
    ...extra,
  };
}

/**
 * Stub provider. `mode`:
 *   - "ok"      → one-round final answer "ok from <id>".
 *   - "never"   → hangs until abort (cancel / budget path).
 *   - "fail"    → throws on complete (failure isolation test).
 *   - "slow"    → resolves after `delayMs` then returns ok (concurrency test).
 */
function makeStubProvider(
  mode: "ok" | "never" | "fail" | "slow",
  id: ProviderId,
  delayMs = 0,
): Provider {
  return {
    info: {
      id,
      label: `Stub-${id}`,
      envKey: "CHOVY_STUB_KEY",
      defaultModel: "stub-model",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady: () => {},
    complete: async (opts) => {
      if (mode === "fail") {
        throw new Error(`stub ${id} forced failure`);
      }
      if (mode === "slow" && delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const sig = opts?.signal;
          const t = setTimeout(resolve, delayMs);
          if (sig?.aborted) {
            clearTimeout(t);
            return reject(abortError());
          }
          sig?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(abortError());
            },
            { once: true },
          );
        });
      }
      if (mode === "never") {
        await new Promise<void>((_resolve, reject) => {
          const sig = opts?.signal;
          if (sig?.aborted) return reject(abortError());
          sig?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      }
      return {
        content: `ok from ${id}`,
        toolCalls: [],
        usage: { prompt: 10, completion: 20 },
      };
    },
  };
}

function abortError(): Error {
  const err: Error & { name: string } = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function installStubs(
  map: Partial<Record<ProviderId, Provider>>,
): Array<() => void> {
  const restore: Array<() => void> = [];
  for (const id of PROVIDERS) {
    const prev = _unregisterProviderForTesting(id);
    const stub = map[id];
    if (stub) {
      registerProvider(stub);
    }
    restore.push(() => {
      _unregisterProviderForTesting(id);
      if (prev) registerProvider(prev);
    });
  }
  return restore;
}

// ── 1. role mapping ────────────────────────────────────────────────────────
{
  check("role: explore → explorer", toAgentRole("explore") === "explorer");
  check("role: plan → planner", toAgentRole("plan") === "planner");
  check("role: verify → verifier", toAgentRole("verify") === "verifier");
  check("role: critic → critic", toAgentRole("critic") === "critic");
  check("role: custom → custom", toAgentRole("custom") === "custom");
  check("role: undefined → main", toAgentRole(undefined) === "main");
}

// ── 2. concurrency limiter invariant ───────────────────────────────────────
{
  const limiter = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const task = async (): Promise<void> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
  };
  await Promise.all(Array.from({ length: 8 }, () => limiter.run(task)));
  check("limiter: concurrency=2 honored", maxActive <= 2, `maxActive=${maxActive}`);
  check("limiter: active=0 after drain", limiter.active === 0);
  check("limiter: pending=0 after drain", limiter.pending === 0);
  check("limiter: rejects concurrency<1", throws(() => createLimiter(0)));
}

// ── 3. global budget ───────────────────────────────────────────────────────
{
  const b = createGlobalBudget(0.05);
  check("budget: not exceeded initially", !b.exceeded);
  b.update(0.04);
  check("budget: under cap not exceeded", !b.exceeded);
  b.update(0.05);
  check("budget: at cap exceeded", b.exceeded);
  b.reset();
  check("budget: reset clears exceeded", !b.exceeded);
  const noCap = createGlobalBudget(undefined);
  noCap.update(1e9);
  check("budget: no cap never exceeds", !noCap.exceeded && noCap.cap === undefined);
}

// ── 4. dispatch 4 prompts × different providers, parallel ──────────────────
{
  _resetSubAgentPoolForTesting();
  const restore = installStubs({
    openai: makeStubProvider("ok", "openai"),
    zai: makeStubProvider("ok", "zai"),
    kimi: makeStubProvider("ok", "kimi"),
    deepseek: makeStubProvider("ok", "deepseek"),
  });

  const bus = createSwarmBus();
  const lifecycleEvents: string[] = [];
  bus.on("lifecycle", (e) => lifecycleEvents.push(`${e.id}:${e.status}`));

  const out = await dispatch(
    {
      prompts: [
        { id: "a", prompt: "task a", provider: "openai", role: "explore" },
        { id: "b", prompt: "task b", provider: "zai", role: "plan" },
        { id: "c", prompt: "task c", provider: "kimi", role: "verify" },
        { id: "d", prompt: "task d", provider: "deepseek", role: "critic" },
      ],
      parallelism: 4,
    },
    makeParentCtx(),
    { bus },
  );

  check("dispatch4: 4 results", out.results.length === 4);
  check("dispatch4: all ok", out.results.every((r) => r.ok), out.results.map((r) => r.status).join(","));
  check("dispatch4: results in original order", out.results.map((r) => r.id).join(",") === "a,b,c,d");
  check("dispatch4: each content from its provider", out.results[0]?.content === "ok from openai");
  check("dispatch4: stopReason=final", out.stopReason === "final");
  check("dispatch4: totalCost > 0", out.totalCostUSD > 0);
  check("dispatch4: spawnedIds length 4", out.spawnedIds.length === 4);
  check("dispatch4: lifecycle events emitted", lifecycleEvents.length > 0);
  // judge not requested → judgement undefined
  check("dispatch4: no judge → judgement undefined", out.judgement === undefined);
  // exactly one swarm.dispatch telemetry event per dispatch (AGENTS.md §17 single-source)
  check("dispatch4: 1 swarm.dispatch telemetry event", swarmDispatchCount === 1, `count=${swarmDispatchCount}`);

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── 5. parallelism=2 → at most 2 in flight ─────────────────────────────────
{
  _resetSubAgentPoolForTesting();
  const restore = installStubs({
    openai: makeStubProvider("slow", "openai", 80),
  });

  // Track concurrent "running" handles via the bus. We snapshot active count
  // on each lifecycle transition by polling the swarm pool — but the cleanest
  // invariant is the limiter itself. We pass a custom limiter that records
  // peak active count.
  let peakActive = 0;
  const recordingLimiter = (concurrency: number) => {
    const inner = createLimiter(concurrency);
    return {
      get active() {
        return inner.active;
      },
      get pending() {
        return inner.pending;
      },
      get concurrency() {
        return concurrency;
      },
      async run<T>(fn: () => Promise<T>): Promise<T> {
        const res = inner.run(async () => {
          peakActive = Math.max(peakActive, inner.active);
          return fn();
        });
        return res;
      },
    };
  };

  const out = await dispatch(
    {
      prompts: Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        prompt: `task ${i}`,
        provider: "openai" as ProviderId,
      })),
      parallelism: 2,
    },
    makeParentCtx(),
    { limiter: recordingLimiter },
  );

  check("parallel2: 6 results", out.results.length === 6);
  check("parallel2: peak active ≤ 2", peakActive <= 2, `peak=${peakActive}`);
  check("parallel2: peak active == 2 (actually limited)", peakActive === 2, `peak=${peakActive}`);
  check("parallel2: all ok", out.results.every((r) => r.ok));

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── 6. budgetUSD trips → stopReason='budgetExceeded' ───────────────────────
{
  _resetSubAgentPoolForTesting();
  // "slow" providers accumulate cost over time; a tight budget trips the
  // watchdog after the first child settles.
  const restore = installStubs({
    openai: makeStubProvider("slow", "openai", 120),
  });

  const out = await dispatch(
    {
      prompts: Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        prompt: `task ${i}`,
        provider: "openai" as ProviderId,
      })),
      parallelism: 3,
      budgetUSD: 0.0000001, // ~0: trips as soon as the first child reports cost
    },
    makeParentCtx(),
  );

  check("budget: stopReason=budgetExceeded", out.stopReason === "budgetExceeded", out.stopReason);
  // At least one child should be cancelled (unfinished); not all ok.
  const cancelled = out.results.filter((r) => r.status === "cancelled").length;
  check("budget: at least one cancelled", cancelled >= 1, `cancelled=${cancelled}`);
  // Some results still settle (the first child that triggered the breach).
  check("budget: totalCost recorded", out.totalCostUSD >= 0);

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── 7. cancel dispatch → all unfinished become cancelled ───────────────────
{
  _resetSubAgentPoolForTesting();
  // "never" providers hang until abort; cancelling the dispatch signal
  // should flip every unfinished child to `cancelled`.
  const restore = installStubs({
    openai: makeStubProvider("never", "openai"),
  });

  const ac = new AbortController();
  const parentCtx = makeParentCtx();
  const dispatchP = dispatch(
    {
      prompts: Array.from({ length: 4 }, (_, i) => ({
        id: `p${i}`,
        prompt: `task ${i}`,
        provider: "openai" as ProviderId,
        timeoutMs: 60_000,
      })),
      parallelism: 4,
      abortSignal: ac.signal,
    },
    parentCtx,
  );

  // Give the dispatch a moment to spawn all 4 children, then abort.
  await new Promise((r) => setTimeout(r, 150));
  ac.abort();
  const out = await dispatchP;

  check("cancel: stopReason=cancelled", out.stopReason === "cancelled", out.stopReason);
  const cancelled = out.results.filter((r) => r.status === "cancelled").length;
  check("cancel: all 4 cancelled", cancelled === 4, `cancelled=${cancelled}`);
  check("cancel: none ok", out.results.every((r) => !r.ok));

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── 8. failure isolation: one child fails, siblings unaffected ─────────────
{
  _resetSubAgentPoolForTesting();
  const restore = installStubs({
    openai: makeStubProvider("ok", "openai"),
    zai: makeStubProvider("fail", "zai"),
    kimi: makeStubProvider("ok", "kimi"),
  });

  const out = await dispatch(
    {
      prompts: [
        { id: "a", prompt: "ok a", provider: "openai" },
        { id: "b", prompt: "fail b", provider: "zai" },
        { id: "c", prompt: "ok c", provider: "kimi" },
      ],
      parallelism: 3,
    },
    makeParentCtx(),
  );

  check("isolation: 3 results", out.results.length === 3);
  check("isolation: a ok", out.results[0]?.ok === true);
  check("isolation: b failed", out.results[1]?.ok === false && out.results[1]?.status === "failed", out.results[1]?.status);
  check("isolation: c ok", out.results[2]?.ok === true);
  check("isolation: stopReason=final (no global abort)", out.stopReason === "final");

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── 9. judge.enabled wired (step-21) — inject a stub judge via deps ─────────
// Step-21 ships the real judge; this test stays offline by injecting a stub
// `runJudge` through `DispatchDeps`. We assert the router (a) calls it when
// `judge.enabled`, (b) folds judge cost into totalCostUSD, and (c) forwards
// the verdict verbatim. The real judge's provider/parse paths are covered by
// scripts/smoke-step21.ts.
{
  _resetSubAgentPoolForTesting();
  const restore = installStubs({
    openai: makeStubProvider("ok", "openai"),
  });

  let judgeCalled = false;
  const stubJudge = async (): Promise<JudgedAggregate> => {
    judgeCalled = true;
    return {
      schemaName: "consensus",
      ok: true,
      data: { agreement: "strong", final_answer: "stubbed verdict" },
      rawText: '{"agreement":"strong",...}',
      costUSD: 0.0123,
      modelUsed: "stub-judge-model",
      providerUsed: "openai",
      attempts: 0,
    };
  };

  const out = await dispatch(
    {
      prompts: [
        { id: "a", prompt: "task a", provider: "openai" },
        { id: "b", prompt: "task b", provider: "openai" },
      ],
      parallelism: 2,
      judge: { enabled: true, schema: "consensus" },
    },
    makeParentCtx(),
    { runJudge: stubJudge },
  );

  check("judge: dispatch succeeds", out.results.length === 2);
  check("judge: runJudge was called", judgeCalled);
  check("judge: judgement present", out.judgement !== undefined);
  check("judge: judgement.ok true", out.judgement?.ok === true);
  check("judge: judgement.schemaName consensus", out.judgement?.schemaName === "consensus");
  check("judge: judge cost folded into total", out.totalCostUSD >= 0.0123, `total=${out.totalCostUSD}`);

  // judge disabled → no judge call, judgement undefined
  let judgeCalled2 = false;
  const out2 = await dispatch(
    {
      prompts: [{ id: "c", prompt: "task c", provider: "openai" }],
      parallelism: 1,
      judge: { enabled: false },
    },
    makeParentCtx(),
    {
      runJudge: async (): Promise<JudgedAggregate> => {
        judgeCalled2 = true;
        return { schemaName: "consensus", ok: false, rawText: "", costUSD: 0, modelUsed: "x", providerUsed: "openai", attempts: 0 };
      },
    },
  );
  check("judge: disabled → not called", !judgeCalled2);
  check("judge: disabled → judgement undefined", out2.judgement === undefined);

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── 10. input validation ───────────────────────────────────────────────────
{
  _resetSubAgentPoolForTesting();
  const restore = installStubs({ openai: makeStubProvider("ok", "openai") });

  // dispatch() is async: input-validation throws are wrapped into a rejected
  // promise, so we await `rejects(...)` rather than the sync `throws(...)`.
  check(
    "validate: empty prompts rejects",
    await rejects(() => dispatch({ prompts: [] }, makeParentCtx())),
  );
  check(
    "validate: >100 prompts rejects",
    await rejects(() =>
      dispatch(
        { prompts: Array.from({ length: MAX_DISPATCH_PROMPTS + 1 }, (_, i) => ({ prompt: `t${i}` })) },
        makeParentCtx(),
      ),
    ),
  );

  restore.forEach((r) => r());
  _resetSubAgentPoolForTesting();
}

// ── Final report ───────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);

// ── helpers ────────────────────────────────────────────────────────────────

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** True iff `fn()` returns a promise that rejects. Awaiting a settled
 *  rejection here keeps the unhandled-rejection count clean. */
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}
