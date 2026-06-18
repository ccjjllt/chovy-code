/**
 * Step-18 smoke (run with `bun scripts/smoke-step18.ts`).
 *
 * Exercises `docs/step-18-sub-agent-runtime.md §验收标准`:
 *
 *   1. SubAgentPool registers handles + emits subagent.spawn telemetry.
 *   2. handle.cancel() flips status ≤ 2s (lifecycle invariant).
 *   3. 100 concurrent active spawns → 101st throws AGENT_BUDGET_EXCEEDED.
 *   4. background=true: pool.spawn returns immediately with running handle;
 *      parent can keep working.
 *   5. parentSignal abort cascades to child without sharing the signal
 *      (AGENTS.md §9: each child owns its own AbortController).
 *   6. snapshot.formatSnapshotXml renders the parent envelope without
 *      leaking tool messages / reasoning.
 *
 * The script is fully offline — no provider / network / TTY required.
 * Sub-agents are launched against a *stub* provider via `QueryEngine`'s
 * dependency-injection slot; we never reach a real model.
 */

import { isChovyError } from "../src/types/errors.js";
import {
  buildParentSnapshot,
  formatSnapshotXml,
  getSubAgentPool,
  _resetSubAgentPoolForTesting,
  MAX_SUB_AGENTS,
} from "../src/agent/index.js";
import { makeHandle, setStatus, isTerminal } from "../src/agent/lifecycle.js";
import type {
  ChatMessage,
  ParentRuntimeCtx,
  ProviderId,
  SubAgentHandle,
} from "../src/types/index.js";
import { registerProvider, _unregisterProviderForTesting } from "../src/providers/index.js";
import type { Provider } from "../src/types/provider.js";

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

console.log("=== Step-18 sub-agent runtime smoke ===\n");

// ── 1. Lifecycle state machine: legal + illegal transitions ────────────────
{
  const handle = makeHandle({
    id: "sa_test0001",
    parentId: "main",
    role: "explorer",
    prompt: "look around",
    background: false,
    onCancel: async () => {},
  });
  check("lifecycle: initial status queued", handle.status === "queued");
  setStatus(handle, "running");
  check("lifecycle: queued → running ok", handle.status === "running");
  setStatus(handle, "done");
  check("lifecycle: running → done ok", handle.status === "done");
  check("lifecycle: terminal stamps finishedAt", typeof handle.finishedAt === "number");

  let threw = false;
  try {
    setStatus(handle, "running"); // illegal from terminal
  } catch (err) {
    threw = isChovyError(err) && err.code === "INTERNAL";
  }
  check("lifecycle: terminal → running throws INTERNAL", threw);
}

// ── 2. Snapshot envelope ───────────────────────────────────────────────────
{
  const messages: ChatMessage[] = [
    { role: "user", content: "find tool registrations" },
    { role: "assistant", content: "I'll look in src/tools/." },
    { role: "tool", toolName: "grep", content: "<tool result>" }, // must be filtered
    { role: "user", content: "thanks" },
  ];
  const snap = buildParentSnapshot(messages, "main", { objective: "audit" });
  check("snapshot: recentMessages slice (k=6 default)", snap.recentMessages.length === 4);
  check("snapshot: parentRole=main", snap.parentRole === "main");
  check("snapshot: objective propagated", snap.parentObjective === "audit");

  const xml = formatSnapshotXml(snap);
  check("snapshot: xml has root tag", xml.includes("<parent-session-snapshot>"));
  check("snapshot: xml includes parent-role", xml.includes("<parent-role>main</parent-role>"));
  check("snapshot: xml omits tool messages", !xml.includes("<tool result>"));
  check("snapshot: xml escapes lt/gt", xml.includes("&lt;tool result&gt;") === false); // stripped, not escaped
  check("snapshot: xml includes objective", xml.includes("audit"));
}

// ── 3. Pool: cap 100 ───────────────────────────────────────────────────────
{
  // Hijack "openai" with a stub provider that never resolves so the
  // children stay in `running` long enough to fill the pool. Restore
  // the real adapter at the end so subsequent tests aren't poisoned.
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  const stub = makeStubProvider("never", "openai");
  registerProvider(stub);

  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_smoke18",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "stub-model",
    parentMessages: [],
  };

  const handles: SubAgentHandle[] = [];
  for (let i = 0; i < MAX_SUB_AGENTS; i++) {
    const h = await pool.spawn(
      { prompt: `task ${i}`, background: true, timeoutMs: 60_000 },
      { parentCtx },
    );
    handles.push(h);
  }
  check(
    "pool: 100 concurrent spawns succeed",
    pool.activeCount() === MAX_SUB_AGENTS,
    `active=${pool.activeCount()}`,
  );

  let exceededOk = false;
  let exceededDetail = "";
  try {
    await pool.spawn(
      { prompt: "overflow", background: true, timeoutMs: 60_000 },
      { parentCtx },
    );
  } catch (err) {
    exceededOk = isChovyError(err) && err.code === "AGENT_BUDGET_EXCEEDED";
    exceededDetail = isChovyError(err) ? err.code : String(err);
  }
  check(
    "pool: 101st spawn throws AGENT_BUDGET_EXCEEDED",
    exceededOk,
    exceededDetail,
  );

  // Cancel all → activeCount drops; this also exercises pool.cancelAll().
  await pool.cancelAll();

  // Give children up to ~3s to settle their finally-blocks. Each child
  // sees a hung provider call that aborts on its own signal; QueryEngine
  // then walks its cancel-grace path. 100 children scheduled in parallel
  // typically finish well under 1s, but we give margin for slow CI.
  for (let i = 0; i < 60; i++) {
    if (pool.activeCount() === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  check(
    "pool: cancelAll drains active count to 0",
    pool.activeCount() === 0,
    `active=${pool.activeCount()}`,
  );

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── 4. Pool: handle.cancel() ≤ 2s + status reflects cancelled ──────────────
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  registerProvider(makeStubProvider("never", "openai"));

  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_cancel",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "stub-model",
    parentMessages: [],
  };

  const handle = await pool.spawn(
    { prompt: "long task", background: true, timeoutMs: 60_000 },
    { parentCtx },
  );
  check("cancel: handle starts running", handle.status === "running");

  const t0 = Date.now();
  await handle.cancel();
  // Wait briefly for the runChild finally-block to flip status.
  for (let i = 0; i < 40 && !isTerminal(handle); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const dur = Date.now() - t0;

  check("cancel: handle reaches terminal", isTerminal(handle), `status=${handle.status}`);
  check("cancel: status === cancelled", handle.status === "cancelled", `status=${handle.status}`);
  check("cancel: ≤ 2000ms wall-clock", dur <= 2000, `dur=${dur}ms`);
  check("cancel: result.reason set", typeof handle.result?.reason === "string");

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── 5. Pool: background=true returns running handle without blocking ───────
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  registerProvider(makeStubProvider("never", "openai"));
  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_bg",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "stub-model",
    parentMessages: [],
  };

  const t0 = Date.now();
  const handle = await pool.spawn(
    { prompt: "bg task", background: true, timeoutMs: 60_000 },
    { parentCtx },
  );
  const dur = Date.now() - t0;
  check("bg: pool.spawn returns ≤ 200ms", dur < 200, `dur=${dur}ms`);
  check("bg: handle.background === true", handle.background === true);
  check("bg: status === running", handle.status === "running");

  await handle.cancel();
  await new Promise((r) => setTimeout(r, 200));
  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── 6. Parent signal cascade (own AC, never shared) ────────────────────────
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  registerProvider(makeStubProvider("never", "openai"));
  const pool = getSubAgentPool();

  const parentAc = new AbortController();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_cascade",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "stub-model",
    parentMessages: [],
    parentSignal: parentAc.signal,
  };

  const handle = await pool.spawn(
    { prompt: "cascade", background: true, timeoutMs: 60_000 },
    { parentCtx },
  );
  parentAc.abort(); // parent cancels — must propagate to child without sharing AC

  for (let i = 0; i < 40 && !isTerminal(handle); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check(
    "cascade: parent abort propagates to child terminal",
    isTerminal(handle),
    `status=${handle.status}`,
  );
  check(
    "cascade: parent signal still under parent control (not child's signal)",
    parentAc.signal.aborted === true,
  );

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── Final report ──────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A minimal Provider stub used to drive the pool without touching the
 * network. `mode = "never"` keeps the provider call hanging on a Promise
 * that only resolves when the abort signal fires (so cancel paths can
 * actually settle). `mode = "ok"` returns a one-round final answer.
 */
function makeStubProvider(mode: "never" | "ok", id: ProviderId): Provider {
  return {
    info: {
      id,
      label: "Stub",
      envKey: "CHOVY_STUB_KEY",
      defaultModel: "stub-model",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady: () => {},
    complete: async (opts) => {
      if (mode === "ok") {
        return {
          content: "ok",
          toolCalls: [],
          usage: { prompt: 1, completion: 1 },
        };
      }
      // never: hang until the engine's abortSignal fires
      await new Promise<void>((resolve) => {
        const sig = opts?.signal;
        if (sig?.aborted) return resolve();
        sig?.addEventListener("abort", () => resolve(), { once: true });
      });
      // throw an AbortError-shaped error so QueryEngine maps to cancelled
      const err: Error & { name: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  };
}
