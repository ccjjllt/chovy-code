/**
 * Step-11 smoke test (run with `bun scripts/smoke-step11.ts`).
 *
 * Exercises the headline acceptance criteria from
 * `docs/step-11-meta-tools.md §"验收标准"`:
 *
 *   1. TodoWrite: write-then-write merges idempotently (positional when ids
 *      absent; by id when present).
 *   2. TodoWrite: at most one `in_progress` — extras are auto-demoted.
 *   3. TodoWrite: 50-item cap enforced by the zod schema.
 *   4. AskUserQuestion: non-interactive (no TTY) ⇒ `TOOL_DENIED`.
 *   5. AskUserQuestion: interactive but no overlay ⇒ `INTERNAL` → step-22.
 *   6. AskUserQuestion: `ctx.askUser` wired ⇒ returns answers.
 *   7. Skill: stub refuses `INTERNAL` → step-29.
 *   8. Agent: stub refuses `INTERNAL` → step-18 (no ctx.spawnSubAgent).
 *   9. Agent: with `ctx.spawnSubAgent` wired ⇒ delegates.
 *  10. ATP: meta tools score/upgrade correctly on keyword match.
 *
 * The script is fully offline — no network, no TTY required.
 */

import { describeTools } from "../src/tools/describe.js";
import { listTools } from "../src/tools/index.js";
// Trigger registration of all built-ins.
import "../src/tools/index.js";
import {
  todoWriteTool,
  askUserQuestionTool,
  skillTool,
  agentTool,
  readTodoList,
  _resetTodoStoreForTesting,
} from "../src/tools/meta/index.js";
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

/** Build a minimal ToolContext shape for tests that need one. */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: console as unknown as ToolContext["logger"],
    permissions: {},
    hooks: {},
    config: {} as ToolContext["config"],
    sessionId: "smoke-step11",
    projectId: "smoke",
    ...overrides,
  };
}

function isToolResult(r: string | ToolResult): r is ToolResult {
  return typeof r !== "string";
}

console.log("\n=== Step-11 meta tools smoke ===\n");

// ── 0. Registration ─────────────────────────────────────────────────────────
{
  const names = listTools().map((t) => t.name);
  check("registry: todo_write registered", names.includes("todo_write"));
  check("registry: ask_user_question registered", names.includes("ask_user_question"));
  check("registry: skill registered", names.includes("skill"));
  check("registry: agent registered", names.includes("agent"));
}

// ── 1. TodoWrite: positional merge (no ids) ────────────────────────────────
{
  _resetTodoStoreForTesting();
  // Provide a session object so we exercise the ctx.session.todoList path
  // (the production path once step-16 wires ToolContext).
  const ctx = makeCtx({ session: {} });

  // First write: 3 items.
  let r = await todoWriteTool.run(
    {
      todos: [
        { content: "A", status: "completed", priority: "high" },
        { content: "B", status: "in_progress", priority: "high" },
        { content: "C", status: "pending", priority: "low" },
      ],
    },
    ctx,
  );
  check("todo_write: first write ok", isToolResult(r) && r.ok, JSON.stringify(r));
  let list = readTodoList(ctx);
  check("todo_write: first write has 3 items", list.length === 3, `len=${list.length}`);
  check("todo_write: B is in_progress", list[1]?.status === "in_progress");

  // Second write (positional): only change item at index 1's status; item at
  // index 0 and 2 are re-sent unchanged. Since writes are replacements, the
  // whole list is replaced — the "merge" semantic here is that the agent
  // re-sends the full list and it lands verbatim.
  r = await todoWriteTool.run(
    {
      todos: [
        { content: "A", status: "completed", priority: "high" },
        { content: "B", status: "completed", priority: "high" },
        { content: "C", status: "in_progress", priority: "low" },
      ],
    },
    ctx,
  );
  check("todo_write: second write ok", isToolResult(r) && r.ok);
  list = readTodoList(ctx);
  check("todo_write: second write still 3 items", list.length === 3);
  check("todo_write: B now completed", list[1]?.status === "completed");
  check("todo_write: C now in_progress", list[2]?.status === "in_progress");

  // Persisted to ctx.session.todoList (in-memory).
  check(
    "todo_write: persisted on ctx.session.todoList",
    ctx.session?.todoList?.length === 3,
  );
}

// ── 2. TodoWrite: id-based merge ───────────────────────────────────────────
{
  _resetTodoStoreForTesting();
  const ctx = makeCtx();

  // Seed with 3 id'd items.
  await todoWriteTool.run(
    {
      todos: [
        { id: "t1", content: "First", status: "pending", priority: "high" },
        { id: "t2", content: "Second", status: "pending", priority: "medium" },
        { id: "t3", content: "Third", status: "pending", priority: "low" },
      ],
    },
    ctx,
  );

  // Update ONLY t2 by id; the other two should be preserved.
  await todoWriteTool.run(
    {
      todos: [{ id: "t2", content: "Second", status: "completed", priority: "medium" }],
    },
    ctx,
  );

  const list = readTodoList(ctx);
  check("todo_write: id-merge keeps 3 items", list.length === 3, `len=${list.length}`);
  const t2 = list.find((t) => t.id === "t2");
  check("todo_write: t2 updated to completed", t2?.status === "completed");
  const t1 = list.find((t) => t.id === "t1");
  check("todo_write: t1 preserved pending", t1?.status === "pending");
  const t3 = list.find((t) => t.id === "t3");
  check("todo_write: t3 preserved pending", t3?.status === "pending");
}

// ── 3. TodoWrite: ≤1 in_progress enforcement ───────────────────────────────
{
  _resetTodoStoreForTesting();
  const ctx = makeCtx();

  const r = await todoWriteTool.run(
    {
      todos: [
        { content: "X", status: "in_progress", priority: "high" },
        { content: "Y", status: "in_progress", priority: "high" },
        { content: "Z", status: "in_progress", priority: "high" },
      ],
    },
    ctx,
  );
  check("todo_write: multi-in_progress write still ok", isToolResult(r) && r.ok);

  const list = readTodoList(ctx);
  const inFlight = list.filter((t) => t.status === "in_progress").length;
  check("todo_write: at most 1 in_progress after enforce", inFlight === 1, `inFlight=${inFlight}`);

  const so = isToolResult(r) ? r.structuredOutput : null;
  check(
    "todo_write: demoted=2 reported",
    so != null && (so as { demoted?: number }).demoted === 2,
    JSON.stringify(so),
  );
}

// ── 4. TodoWrite: 50-item cap via schema ───────────────────────────────────
{
  _resetTodoStoreForTesting();
  const tooMany = Array.from({ length: 51 }, (_, i) => ({
    content: `item ${i}`,
    status: "pending" as const,
    priority: "low" as const,
  }));
  const parsed = todoWriteTool.schema.safeParse({ todos: tooMany });
  check("todo_write: schema rejects 51 items", !parsed.success, "should have failed");
  if (!parsed.success) {
    check(
      "todo_write: cap error mentions 50",
      /50/.test(parsed.error.message),
      parsed.error.message,
    );
  }

  // 50 is allowed.
  const fifty = tooMany.slice(0, 50);
  const ok50 = todoWriteTool.schema.safeParse({ todos: fifty });
  check("todo_write: schema accepts 50 items", ok50.success);
}

// ── 5. AskUserQuestion: non-interactive ⇒ TOOL_DENIED ──────────────────────
{
  // Force non-interactive via isInteractive callback returning false.
  const ctx = makeCtx({
    isInteractive: () => false,
    askUser: async () => ({ "q?": "A" }), // would answer if reached
  });
  const r = await askUserQuestionTool.run(
    {
      questions: [
        {
          question: "q?",
          header: "Pick",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    },
    ctx,
  );
  check(
    "ask_user: non-interactive refuses with TOOL_DENIED",
    isToolResult(r) && r.ok === false && r.errorCode === "TOOL_DENIED",
    JSON.stringify(r),
  );
  check(
    "ask_user: non-interactive content mentions non-interactive",
    isToolResult(r) && /非交互|non-interactive/i.test(r.content),
  );
}

// ── 6. AskUserQuestion: interactive but no overlay ⇒ INTERNAL → step-22 ────
{
  const ctx = makeCtx({
    isInteractive: () => true,
    // no askUser
  });
  const r = await askUserQuestionTool.run(
    {
      questions: [
        {
          question: "which?",
          header: "Choice",
          options: [
            { label: "X", description: "x" },
            { label: "Y", description: "y" },
          ],
        },
      ],
    },
    ctx,
  );
  check(
    "ask_user: no-overlay refuses with INTERNAL",
    isToolResult(r) && r.ok === false && r.errorCode === "INTERNAL",
    JSON.stringify(r),
  );
  check(
    "ask_user: no-overlay points at step-22",
    isToolResult(r) && /step-22/.test(r.content),
  );
  const so = isToolResult(r) ? r.structuredOutput : null;
  check(
    "ask_user: structuredOutput kind=no-overlay",
    (so as { kind?: string })?.kind === "no-overlay",
  );
}

// ── 7. AskUserQuestion: ctx.askUser wired ⇒ returns answers ────────────────
{
  let receivedSpecs: unknown = null;
  const ctx = makeCtx({
    isInteractive: () => true,
    askUser: async (specs) => {
      receivedSpecs = specs;
      // Simulate the user picking the first option for each question.
      const out: Record<string, string> = {};
      for (const s of specs) out[s.question] = s.options[0]!.label;
      return out;
    },
  });
  const r = await askUserQuestionTool.run(
    {
      questions: [
        {
          question: "library?",
          header: "Lib",
          options: [
            { label: "Zod", description: "runtime validation" },
            { label: "Yup", description: "alt validation" },
          ],
        },
      ],
    },
    ctx,
  );
  check("ask_user: wired call ok", isToolResult(r) && r.ok, JSON.stringify(r));
  check(
    "ask_user: callback received the spec",
    Array.isArray(receivedSpecs) && (receivedSpecs as unknown[]).length === 1,
  );
  const so = isToolResult(r) ? r.structuredOutput : null;
  const answers = (so as { answers?: Record<string, string> })?.answers;
  check(
    "ask_user: answer forwarded as Zod",
    answers?.["library?"] === "Zod",
    JSON.stringify(answers),
  );
}

// ── 8. Skill stub ⇒ INTERNAL → step-29 ─────────────────────────────────────
{
  const r = await skillTool.run({ skill: "commit" });
  check(
    "skill: stub refuses with INTERNAL",
    isToolResult(r) && r.ok === false && r.errorCode === "INTERNAL",
    JSON.stringify(r),
  );
  check(
    "skill: stub points at step-29",
    isToolResult(r) && /step-29/.test(r.content),
  );
  const so = isToolResult(r) ? r.structuredOutput : null;
  check(
    "skill: structuredOutput kind=stub step=step-29",
    (so as { kind?: string })?.kind === "stub" &&
      (so as { step?: string })?.step === "step-29",
  );
}

// ── 9. Agent stub (no spawnSubAgent) ⇒ INTERNAL → no-runtime ───────────────
{
  const ctx = makeCtx(); // no spawnSubAgent
  const r = await agentTool.run(
    {
      description: "Find all tool registrations",
      prompt: "List every registerTool call.",
      subagent_type: "Explore",
    },
    ctx,
  );
  check(
    "agent: no-runtime refuses with INTERNAL",
    isToolResult(r) && r.ok === false && r.errorCode === "INTERNAL",
    JSON.stringify(r),
  );
  check(
    "agent: no-runtime msg references runtime / step-18 wiring",
    isToolResult(r) && /spawnSubAgent|SwarmR|step-20/i.test(r.content),
  );
  const so = isToolResult(r) ? r.structuredOutput : null;
  check(
    "agent: structuredOutput kind=no-runtime",
    (so as { kind?: string })?.kind === "no-runtime",
  );
}

// ── 10. Agent: ctx.spawnSubAgent wired ⇒ delegates ─────────────────────────
{
  let receivedReq: unknown = null;
  const fakeHandle: import("../src/types/index.js").SubAgentHandle = {
    id: "sa_smoke001",
    parentId: "smoke-step11",
    role: "verifier",
    prompt: "Run typecheck.",
    status: "running",
    phase: "running",
    spawnedAt: Date.now(),
    costUSD: 0,
    tokensIn: 0,
    tokensOut: 0,
    background: true,
    cancel: async () => {},
  };
  const ctx = makeCtx({
    spawnSubAgent: async (req) => {
      receivedReq = req;
      return fakeHandle;
    },
  });
  const r = await agentTool.run(
    {
      description: "Verify the build",
      prompt: "Run typecheck.",
      subagent_type: "Verify",
      run_in_background: true,
    },
    ctx,
  );
  check(
    "agent: wired call delegates and returns ok",
    isToolResult(r) && r.ok,
    JSON.stringify(r),
  );
  check(
    "agent: spawnSubAgent received SpawnInput with role=verifier",
    receivedReq != null &&
      (receivedReq as { role?: string }).role === "verifier",
  );
  check(
    "agent: result content references background sub-agent id",
    isToolResult(r) && /sa_smoke001/.test(r.content),
  );
}

// ── 11. ATP: meta tools upgrade on keyword match ───────────────────────────
{
  // Default: ample budget, irrelevant message → meta tools lean.
  const lean = describeTools({
    budgetTokens: 6000,
    recentMessages: [{ role: "user", content: "review this typescript code" }],
    lastToolCalls: [],
  });
  const leanTodo = lean.find((d) => d.name === "todo_write");
  check(
    "ATP: todo_write defaults to lean when not relevant",
    leanTodo?.level === "lean",
    JSON.stringify(leanTodo),
  );

  // With a "todo/plan steps" keyword, todo_write should upgrade.
  const upgraded = describeTools({
    budgetTokens: 6000,
    recentMessages: [{ role: "user", content: "Let's plan steps and track the todo list" }],
    lastToolCalls: [],
  });
  const upTodo = upgraded.find((d) => d.name === "todo_write");
  check(
    "ATP: todo_write upgrades to full on keyword",
    upTodo?.level === "full",
    JSON.stringify(upTodo),
  );

  // AskUser upgrades on "ask the user".
  const askUp = describeTools({
    budgetTokens: 6000,
    recentMessages: [{ role: "user", content: "which option should I pick? ask the user" }],
    lastToolCalls: [],
  });
  const upAsk = askUp.find((d) => d.name === "ask_user_question");
  check(
    "ATP: ask_user_question upgrades to full on keyword",
    upAsk?.level === "full",
    JSON.stringify(upAsk),
  );
}

// ── 12. TodoWrite: clears when empty list sent ─────────────────────────────
{
  _resetTodoStoreForTesting();
  const ctx = makeCtx();
  await todoWriteTool.run(
    { todos: [{ content: "only", status: "in_progress", priority: "high" }] },
    ctx,
  );
  const r = await todoWriteTool.run({ todos: [] }, ctx);
  check("todo_write: empty list clears", isToolResult(r) && r.ok);
  check("todo_write: list now empty", readTodoList(ctx).length === 0);
  check(
    "todo_write: content mentions cleared",
    isToolResult(r) && /cleared/i.test(r.content),
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
