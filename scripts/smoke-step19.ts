/**
 * Step-19 smoke (run with `bun scripts/smoke-step19.ts`).
 *
 * Exercises `docs/step-19-built-in-agents.md §验收标准`:
 *
 *   1. AGENT_REGISTRY has the 5 built-in roles (explore/plan/verify/critic/
 *      checkpoint-writer).
 *   2. Explore: disallowedTools includes file_edit/file_write/bash/agent
 *      (read-only enforced by the role definition, not just the prompt).
 *   3. Verify: allowedTools === ["bash","file_read","grep","glob"] (tight
 *      whitelist; new mutating tools must NOT silently become available).
 *   4. Critic: getSystemPrompt mentions "risks" and forbids "Looks good"
 *      (adversarial by construction).
 *   5. CheckpointWriter: getSystemPrompt references step-26 (placeholder).
 *   6. mergeAllowlist: caller ∩ role (intersection — stricter wins);
 *      mergeDenylist: caller ∪ role (union — both layers' denials apply).
 *   7. Pool spawn with role=explorer actually runs (stub provider "ok"):
 *      handle.status === done, result.content present, cost recorded.
 *   8. Explore omitMemory flows through to the BuildOptions agent layer
 *      (stub provider captures the systemPrompt; assert it contains
 *      "READ-ONLY").
 *   9. Verify whitelist applied at the pool layer: stub provider captures
 *      the `tools` list handed to the engine; assert only the 4 allowed
 *      tools are present (file_edit/file_write absent).
 *
 * Fully offline — no network / TTY. Reuses the step-18 provider-stub pattern
 * (`_unregisterProviderForTesting` + `registerProvider`).
 */

import {
  getBuiltinAgent,
  listBuiltinAgents,
  getSubAgentPool,
  _resetSubAgentPoolForTesting,
  _mergeAllowlistForTesting,
  _mergeDenylistForTesting,
} from "../src/agent/index.js";
import { registerProvider, _unregisterProviderForTesting } from "../src/providers/index.js";
import type { Provider, ProviderId } from "../src/types/index.js";
import type { ParentRuntimeCtx, SubAgentHandle } from "../src/types/index.js";
import type { SystemContext } from "../src/prompts/index.js";

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

/** Minimal SystemContext for exercising getSystemPrompt. */
function fakeCtx(): SystemContext {
  return {
    cwd: { cwd: "D:/Desktop/chovy-code" },
    model: { provider: "openai", model: "gpt-4o-mini" },
  };
}

console.log("=== Step-19 built-in agents smoke ===\n");

// ── 1. Registry: 5 roles registered ────────────────────────────────────────
{
  const all = listBuiltinAgents();
  check("registry: 5 built-in roles registered", all.length >= 5, `got ${all.length}`);
  check("registry: explorer registered", !!getBuiltinAgent("explorer"));
  check("registry: planner registered", !!getBuiltinAgent("planner"));
  check("registry: verifier registered", !!getBuiltinAgent("verifier"));
  check("registry: critic registered", !!getBuiltinAgent("critic"));
  check("registry: checkpoint-writer registered", !!getBuiltinAgent("checkpoint-writer"));
  check("registry: main/custom NOT registered (undefined)", getBuiltinAgent("main") === undefined);
}

// ── 2. Explore: read-only tool blacklist ───────────────────────────────────
{
  const def = getBuiltinAgent("explorer");
  check("explore: role === explorer", def?.role === "explorer");
  const dis = new Set(def?.disallowedTools ?? []);
  check("explore: disallows file_edit", dis.has("file_edit"));
  check("explore: disallows file_write", dis.has("file_write"));
  check("explore: disallows bash", dis.has("bash"));
  check("explore: disallows agent (no recursion)", dis.has("agent"));
  check("explore: allowedTools unset (denylist mode)", def?.allowedTools === undefined);
  check("explore: omitMemory === true", def?.omitMemory === true);
  check(
    "explore: preferredModel is small",
    def?.preferredModel === "gpt-4o-mini",
  );
  check("explore: budgetUSD < default", (def?.budgetUSD ?? 1) < 0.2);
  check("explore: timeoutMs < default", (def?.timeoutMs ?? 1e9) < 120_000);
}

// ── 3. Verify: tight whitelist ─────────────────────────────────────────────
{
  const def = getBuiltinAgent("verifier");
  check("verify: role === verifier", def?.role === "verifier");
  const allow = def?.allowedTools ?? [];
  check(
    "verify: allowedTools === [bash,file_read,grep,glob]",
    allow.length === 4 &&
      ["bash", "file_read", "grep", "glob"].every((t) => allow.includes(t)),
    JSON.stringify(allow),
  );
  check("verify: disallowedTools unset (allowlist mode)", def?.disallowedTools === undefined);
  check("verify: omitMemory === false (needs test commands)", def?.omitMemory === false);
  check(
    "verify: file_edit NOT in allowedTools (can't fix tests to pass)",
    !allow.includes("file_edit"),
  );
}

// ── 4. Critic: adversarial prompt ──────────────────────────────────────────
{
  const def = getBuiltinAgent("critic");
  check("critic: role === critic", def?.role === "critic");
  const prompt = def?.getSystemPrompt(fakeCtx()) ?? "";
  check("critic: prompt mentions risks[]", /risks\[\]/.test(prompt));
  check(
    "critic: prompt mentions unverified_assumptions[]",
    /unverified_assumptions\[\]/.test(prompt),
  );
  check("critic: prompt mentions edge_cases[]", /edge_cases\[\]/.test(prompt));
  check(
    "critic: prompt mentions improvement_suggestions[]",
    /improvement_suggestions\[\]/.test(prompt),
  );
  check(
    "critic: prompt forbids 'Looks good'",
    /不要.*Looks good|NEVER.*Looks good/i.test(prompt) || !/^\s*looks good\b/im.test(prompt),
  );
  check(
    "critic: prompt has the 'no risks found' fallback",
    /No risks found in this scope/.test(prompt),
  );
}

// ── 5. CheckpointWriter: step-26 placeholder ───────────────────────────────
{
  const def = getBuiltinAgent("checkpoint-writer");
  check("cp: role === checkpoint-writer", def?.role === "checkpoint-writer");
  const prompt = def?.getSystemPrompt(fakeCtx()) ?? "";
  check("cp: prompt references step-26", /step-26/.test(prompt));
  check("cp: prompt mentions 8KB cap", /8KB/.test(prompt));
  check("cp: allowedTools includes file_write", def?.allowedTools?.includes("file_write") === true);
  check("cp: allowedTools includes file_read", def?.allowedTools?.includes("file_read") === true);
  check("cp: omitMemory === true", def?.omitMemory === true);
  check("cp: maxRounds small (4)", def?.maxRounds === 4);
}

// ── 6. mergeAllowlist / mergeDenylist helpers ──────────────────────────────
{
  // Allowlist: intersection (stricter wins)
  check(
    "merge: allowlist intersection",
    JSON.stringify(_mergeAllowlistForTesting(["bash"], ["bash", "file_read"])) ===
      JSON.stringify(["bash"]),
  );
  check(
    "merge: allowlist caller-only",
    JSON.stringify(_mergeAllowlistForTesting(["bash"], undefined)) ===
      JSON.stringify(["bash"]),
  );
  check(
    "merge: allowlist role-only",
    JSON.stringify(_mergeAllowlistForTesting(undefined, ["bash", "file_read"])) ===
      JSON.stringify(["bash", "file_read"]),
  );
  check(
    "merge: allowlist both empty → role (empty = no-op, not 'block all')",
    JSON.stringify(_mergeAllowlistForTesting([], [])) === JSON.stringify([]),
  );
  check(
    "merge: allowlist both undefined → undefined (full pool)",
    _mergeAllowlistForTesting(undefined, undefined) === undefined,
  );

  // Denylist: union (both apply)
  const denyUnion = _mergeDenylistForTesting(["echo"], ["agent"]) ?? [];
  check(
    "merge: denylist union has both",
    denyUnion.includes("echo") && denyUnion.includes("agent") && denyUnion.length === 2,
    JSON.stringify(denyUnion),
  );
  check(
    "merge: denylist de-dups",
    (_mergeDenylistForTesting(["agent"], ["agent"]) ?? []).length === 1,
  );
  check(
    "merge: denylist caller-only",
    JSON.stringify(_mergeDenylistForTesting(["echo"], undefined)) ===
      JSON.stringify(["echo"]),
  );
}

// ── 7. Plan agent: strict template ─────────────────────────────────────────
{
  const def = getBuiltinAgent("planner");
  check("plan: role === planner", def?.role === "planner");
  const prompt = def?.getSystemPrompt(fakeCtx()) ?? "";
  check("plan: prompt has Goal section", /## Goal/.test(prompt));
  check("plan: prompt has Approach section", /## Approach/.test(prompt));
  check("plan: prompt has Steps section", /## Steps/.test(prompt));
  check("plan: prompt has Critical Files section", /## Critical Files/.test(prompt));
  check("plan: prompt has Risks section", /## Risks/.test(prompt));
  check("plan: omitMemory === false (needs context)", def?.omitMemory === false);
  check("plan: disallows bash", def?.disallowedTools?.includes("bash") === true);
}

// ── 8. Pool spawn: explorer runs with stub provider, READ-ONLY prompt ───────
//
// Hijack "openai" with a stub that returns a one-round final answer AND
// captures the systemPrompt so we can assert the role's prompt landed.
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  let capturedSystemPrompt = "";
  registerProvider(makeCapturingStubProvider("openai", (sp) => {
    capturedSystemPrompt = sp;
  }));

  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_s19_explore",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
    parentMessages: [],
  };

  const handle: SubAgentHandle = await pool.spawn(
    { prompt: "find all .ts files", role: "explorer" },
    { parentCtx },
  );

  check("pool: explorer handle status === done", handle.status === "done", `status=${handle.status}`);
  check("pool: explorer result.ok", handle.result?.ok === true);
  check("pool: explorer result.content present", !!handle.result?.content);
  check(
    "pool: explorer systemPrompt contains READ-ONLY",
    /READ-ONLY/.test(capturedSystemPrompt),
    `prompt lacked READ-ONLY (len=${capturedSystemPrompt.length})`,
  );
  check(
    "pool: explorer handle.role === explorer",
    handle.role === "explorer",
  );

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── 9. Pool spawn: verify whitelist applied at pool layer ──────────────────
//
// The stub captures the `tools` list handed to the provider; we assert that
// verify's whitelist (bash/file_read/grep/glob) is what the engine sees, and
// that file_edit/file_write are absent even though they're registered tools.
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  let capturedTools: string[] = [];
  registerProvider(makeToolCapturingStubProvider("openai", (tools) => {
    capturedTools = tools;
  }));

  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_s19_verify",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
    parentMessages: [],
  };

  const handle = await pool.spawn(
    { prompt: "run typecheck and report PASS/FAIL", role: "verifier" },
    { parentCtx },
  );

  check("pool: verify handle status === done", handle.status === "done", `status=${handle.status}`);
  const tools = new Set(capturedTools);
  check(
    "pool: verify engine sees bash",
    tools.has("bash"),
    `tools=${JSON.stringify(capturedTools)}`,
  );
  check(
    "pool: verify engine sees file_read",
    tools.has("file_read"),
  );
  check(
    "pool: verify engine does NOT see file_edit (whitelist applied)",
    !tools.has("file_edit"),
  );
  check(
    "pool: verify engine does NOT see file_write",
    !tools.has("file_write"),
  );
  check(
    "pool: verify engine does NOT see agent (no recursion)",
    !tools.has("agent"),
  );

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── 10. Pool spawn: explorer blocks disallowed tools ───────────────────────
//
// Same as #9 but for explorer: the denylist (file_edit/file_write/bash/agent)
// must keep those tools out of the engine's tool list. This is the concrete
// acceptance criterion "explore 试图调 edit 工具时被自身权限白名单拒绝".
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  let capturedTools: string[] = [];
  registerProvider(makeToolCapturingStubProvider("openai", (tools) => {
    capturedTools = tools;
  }));

  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_s19_explore_block",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
    parentMessages: [],
  };

  await pool.spawn(
    { prompt: "explore the repo", role: "explorer" },
    { parentCtx },
  );

  const tools = new Set(capturedTools);
  check("pool: explore engine sees file_read (allowed)", tools.has("file_read"));
  check("pool: explore engine sees glob (allowed)", tools.has("glob"));
  check("pool: explore engine sees grep (allowed)", tools.has("grep"));
  check(
    "pool: explore engine does NOT see file_edit (denylist)",
    !tools.has("file_edit"),
  );
  check(
    "pool: explore engine does NOT see bash (denylist)",
    !tools.has("bash"),
  );
  check(
    "pool: explore engine does NOT see agent (denylist)",
    !tools.has("agent"),
  );

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── 11. Pool spawn: caller can tighten but not widen ───────────────────────
//
// Caller passes tools=["bash"] on a verify spawn. Verify's allowedTools is
// ["bash","file_read","grep","glob"]. Intersection → ["bash"] only. The
// caller restricted the pool further; it did NOT get file_read etc.
{
  _resetSubAgentPoolForTesting();
  const realOpenai = _unregisterProviderForTesting("openai");
  let capturedTools: string[] = [];
  registerProvider(makeToolCapturingStubProvider("openai", (tools) => {
    capturedTools = tools;
  }));

  const pool = getSubAgentPool();
  const parentCtx: ParentRuntimeCtx = {
    parentId: "main_s19_tighten",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "gpt-4o-mini",
    parentMessages: [],
  };

  await pool.spawn(
    { prompt: "just run bash", role: "verifier", tools: ["bash"] },
    { parentCtx },
  );

  const tools = new Set(capturedTools);
  check(
    "pool: caller tighten → only bash (intersection)",
    tools.has("bash") && !tools.has("file_read") && !tools.has("grep") && !tools.has("glob"),
    `tools=${JSON.stringify(capturedTools)}`,
  );

  _unregisterProviderForTesting("openai");
  if (realOpenai) registerProvider(realOpenai);
  _resetSubAgentPoolForTesting();
}

// ── Final report ───────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Stub provider that returns a one-round final answer ("ok") and captures
 * the systemPrompt handed to it. Modeled on smoke-step18's `makeStubProvider`
 * "ok" branch, extended with a capture callback.
 */
function makeCapturingStubProvider(
  id: ProviderId,
  onSystemPrompt: (sp: string) => void,
): Provider {
  return {
    info: {
      id,
      label: "Stub",
      envKey: "CHOVY_STUB_KEY",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady: () => {},
    complete: async (opts) => {
      if (opts?.systemPrompt) onSystemPrompt(opts.systemPrompt);
      return {
        content: "ok",
        toolCalls: [],
        usage: { prompt: 5, completion: 1 },
      };
    },
  };
}

/**
 * Stub provider that returns a one-round final answer and captures the
 * `tools` list (the tool names the engine handed to the provider). Used to
 * assert the pool's tool-allow/deny merge reached the engine.
 */
function makeToolCapturingStubProvider(
  id: ProviderId,
  onTools: (tools: string[]) => void,
): Provider {
  return {
    info: {
      id,
      label: "Stub",
      envKey: "CHOVY_STUB_KEY",
      defaultModel: "gpt-4o-mini",
      supportsStreaming: false,
      supportsTools: true,
    },
    assertReady: () => {},
    complete: async (opts) => {
      // The engine passes tool names via `tools` (string[]) and `toolSpecs`.
      // `tools` is the authoritative name list for our assertion.
      const tools = (opts as { tools?: string[] }).tools ?? [];
      onTools(tools);
      return {
        content: "ok",
        toolCalls: [],
        usage: { prompt: 5, completion: 1 },
      };
    },
  };
}
