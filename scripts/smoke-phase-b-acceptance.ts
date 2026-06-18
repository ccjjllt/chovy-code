/**
 * Phase B 验收脚本 — 验证 2026-06-18 验收追补的 4 项修复
 *
 *   B1: agent loop 是 `tool.call` telemetry 的唯一发射方（工具内不再双发）
 *   B2: agent loop 给 tool.run 注入最小 ToolContext（cwd / abortSignal /
 *       sessionId / projectId / config / session / askUser / isInteractive）
 *   B3: telemetry 的 AgentRole 与 src/types/agent.ts 同源（编译期）
 *   B4: bash.run 把 ctx.abortSignal 真接给 spawn
 *
 * 不依赖网络；不依赖 provider key；不写 ~/.gitconfig 等。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetSecretsCache } from "../src/config/secrets.js";
import { resetConfigCache } from "../src/config/config.js";
import { setTelemetrySink } from "../src/telemetry/index.js";
import type { TelemetryEvent } from "../src/telemetry/events.js";

import { runAgent } from "../src/agent/index.js";
import { getProvider } from "../src/providers/index.js";
import { bashTool } from "../src/tools/exec/index.js";
import type { ToolContext } from "../src/types/index.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: string): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    fail++;
  }
}

// Capture telemetry in-memory
const events: TelemetryEvent[] = [];
setTelemetrySink({
  enabled: true,
  emit: (e) => {
    events.push({ ...e, ts: 0 } as TelemetryEvent);
  },
  flush: async () => {},
  close: () => {},
  currentFile: () => "",
});

// Sandbox the chovy home so loadConfig() sees a clean state.
const home = mkdtempSync(join(tmpdir(), "chovy-phase-b-"));
process.env.CHOVY_HOME = home;
writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "openai", defaultModel: "test-model" }));
writeFileSync(join(home, "features.json"), "{}");
process.env.OPENAI_API_KEY = "test-key";
resetConfigCache();
resetSecretsCache();

console.log("=== Phase B acceptance smoke ===\n");

// ── B4 — bash respects ctx.abortSignal ────────────────────────────────────
async function testBashAbort(): Promise<void> {
  const ac = new AbortController();
  const ctx = {
    cwd: process.cwd(),
    abortSignal: ac.signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as ToolContext["logger"],
    permissions: {},
    hooks: {},
    config: {} as ToolContext["config"],
    sessionId: "smoke",
    projectId: "smoke",
  } satisfies ToolContext;

  // Use a sleep command via the platform's native spawn. On Windows we use
  // PowerShell `Start-Sleep`; on POSIX we use `sleep 5`.
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";

  // Fire abort 100 ms in.
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const r = await bashTool.run({ command, timeoutMs: 30_000 } as unknown as Parameters<typeof bashTool.run>[0], ctx);
  const dur = Date.now() - t0;
  const result = typeof r === "string" ? { ok: true, content: r } : r;

  // Should return well below 5s once the signal fires. We allow 3s so slow
  // CI does not flake; 5s would mean the signal was ignored.
  check("B4: bash returns within 3s after ctx.abortSignal aborts", dur < 3_000, `took ${dur}ms`);
  check("B4: bash run() resolves (does not throw on abort)", typeof result === "object" && "ok" in result);
}

// ── B2 — agent loop wires ToolContext into tool.run ───────────────────────
async function testAgentLoopCtx(): Promise<void> {
  // Stub the registered openai provider so we can drive the agent loop in
  // memory (no network). One round of tool_use → final answer.
  let round = 0;
  let observedCtx: ToolContext | undefined;

  const provider = getProvider("openai");
  const origComplete = provider.complete.bind(provider);
  const origStream = provider.stream?.bind(provider);
  const origAssertReady = provider.assertReady.bind(provider);
  (provider as { assertReady: () => void }).assertReady = () => {};
  (provider as { complete: typeof origComplete }).complete = (async () => {
    round++;
    if (round === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "c1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
        ],
        finishReason: "tool_use",
        model: "test-model",
      };
    }
    return { content: "done", toolCalls: [], finishReason: "stop", model: "test-model" };
  }) as typeof origComplete;
  // Disable streaming path to keep the test deterministic.
  delete (provider as { stream?: unknown }).stream;

  // Patch bashTool.run to record what ctx the agent loop passed.
  const origRun = bashTool.run;
  (bashTool as unknown as { run: typeof origRun }).run = async (_args, ctx) => {
    observedCtx = ctx;
    return { ok: true, content: "captured" };
  };

  try {
    // bypassPermissions so the step-12 permission gate doesn't block the
    // `echo hi` tool call — this test asserts ToolContext wiring, not the
    // permission policy (covered by scripts/smoke-step12.ts).
    await runAgent("hello", { provider: "openai", permissionMode: "bypassPermissions" });
  } finally {
    (bashTool as unknown as { run: typeof origRun }).run = origRun;
    (provider as { complete: typeof origComplete }).complete = origComplete;
    if (origStream) (provider as { stream?: typeof origStream }).stream = origStream;
    (provider as { assertReady: typeof origAssertReady }).assertReady = origAssertReady;
  }

  check("B2: tool.run received a ToolContext", observedCtx !== undefined);
  if (observedCtx) {
    check("B2: ctx.sessionId starts with 'agt_'", observedCtx.sessionId.startsWith("agt_"));
    check("B2: ctx.cwd is process.cwd()", observedCtx.cwd === process.cwd());
    check("B2: ctx.abortSignal is an AbortSignal", typeof observedCtx.abortSignal?.aborted === "boolean");
    check("B2: ctx.session.todoList is an array", Array.isArray(observedCtx.session?.todoList));
    check("B2: ctx.isInteractive callable", typeof observedCtx.isInteractive === "function");
    check("B2: ctx.config present", observedCtx.config !== undefined);
    check("B2: ctx.projectId is 12 hex chars", /^[0-9a-f]{12}$/.test(observedCtx.projectId));
  }
}

// ── B1 — agent loop is the only `tool.call` emitter ───────────────────────
function testTelemetryNoDoubleCount(): void {
  const toolCalls = events.filter((e) => e.type === "tool.call");
  const bashCalls = toolCalls.filter((e) => (e as { tool: string }).tool === "bash");
  // testAgentLoopCtx ran 1 bash tool call ⇒ exactly 1 tool.call event.
  check(
    "B1: exactly one `tool.call` emitted per agent-loop bash call (no double count)",
    bashCalls.length === 1,
    `saw ${bashCalls.length}`,
  );
}

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await testBashAbort();
    await testAgentLoopCtx();
    testTelemetryNoDoubleCount();
  } finally {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
