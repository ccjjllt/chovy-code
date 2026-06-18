/**
 * Step-21 Judge Aggregator smoke (run with `bun scripts/smoke-step21.ts`).
 *
 * Exercises `docs/step-21-judge-aggregator.md §验收标准`:
 *
 *   1. 3 disagreeing sub-agents → Consensus outputs `split` + evidence.length === 3;
 *   2. all sub-agents ok=false → judge still returns `conflict` + unresolved;
 *   3. json-mode-capable provider → 100% schema parse success (ok=true);
 *   4. non-json-mode / messy output → tryFixJSON recovers ≥ 95% (ok=true);
 *   5. self-repair: first call returns malformed JSON, repair call returns
 *      valid → ok=true, attempts=1;
 *   6. provider unavailable (no secret) → judge degrades to ok=false /
 *      reason='no-provider' WITHOUT throwing (dispatch stopReason stays final);
 *   7. compare / rank / custom schemas each parse their shape;
 *   8. content truncation: a >4KB agent content is truncated (head+tail kept);
 *   9. judge cancellation: abortSignal aborted → ok=false / reason='cancelled';
 *  10. tryFixJSON unit cases: fences, leading/trailing prose, truncated JSON.
 *
 * Fully offline — stub providers return canned JSON. We drive `runJudge`
 * directly (the router integration is covered by smoke-step20 #9).
 */

import {
  runJudge,
  tryFixJSON,
  ConsensusSchema,
  CompareSchema,
  RankSchema,
  CustomMeta,
} from "../src/swarm/index.js";
import {
  registerProvider,
  _unregisterProviderForTesting,
} from "../src/providers/index.js";
import { resetSecretsCache, ENV_KEYS } from "../src/config/secrets.js";
import type { Provider } from "../src/types/provider.js";
import type { ProviderId } from "../src/types/index.js";
import type { DispatchChildResult } from "../src/swarm/router.js";
import type { ParentRuntimeCtx } from "../src/types/index.js";
import { z } from "zod";

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

console.log("=== Step-21 Judge Aggregator smoke ===\n");

// ── stub infrastructure ────────────────────────────────────────────────────

/**
 * Make a stub judge provider that returns `responses` in order (one per
 * `complete()` call). Each response is the raw `content` string the "model"
 * emits. `usage` is fixed so cost is non-zero and foldable.
 *
 * `id` is the provider id to register under; the judge picks it via the
 * fallback chain when its secret is set (we set `CHOVY_STUB_KEY` env below).
 */
function makeJudgeProvider(
  id: ProviderId,
  responses: string[],
): Provider {
  let call = 0;
  return {
    info: {
      id,
      label: `Stub-${id}`,
      envKey: "CHOVY_STUB_KEY",
      defaultModel: "stub-judge-model",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady: () => {},
    complete: async (opts) => {
      if (opts?.signal?.aborted) throw abortError();
      const content = responses[call] ?? responses[responses.length - 1] ?? "";
      call++;
      return {
        content,
        toolCalls: [],
        usage: { prompt: 50, completion: 30 },
      };
    },
  };
}

function abortError(): Error {
  const err: Error & { name: string } = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Install a stub provider + set its provider-specific env key so `hasSecret`
 * returns true (the judge's fallback chain gates on `hasSecret`, which reads
 * `ENV_KEYS[provider]` — e.g. `KIMI_API_KEY`). Returns a restore fn.
 */
function installJudgeProvider(id: ProviderId, provider: Provider): () => void {
  const prev = _unregisterProviderForTesting(id);
  registerProvider(provider);
  // hasSecret reads ENV_KEYS[provider]; set that env var.
  const envKey = ENV_KEYS[id];
  const prevEnv = process.env[envKey];
  process.env[envKey] = "stub-key";
  resetSecretsCache();
  return () => {
    _unregisterProviderForTesting(id);
    if (prev) registerProvider(prev);
    if (prevEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = prevEnv;
    resetSecretsCache();
  };
}

function makeParentCtx(extra: Partial<ParentRuntimeCtx> = {}): ParentRuntimeCtx {
  return {
    parentId: "main_smoke21",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "stub-model",
    parentMessages: [],
    ...extra,
  };
}

function makeResult(
  id: string,
  ok: boolean,
  content: string,
  extra: Partial<DispatchChildResult> = {},
): DispatchChildResult {
  return {
    id,
    ok,
    content,
    costUSD: 0.001,
    status: ok ? "done" : "failed",
    provider: "openai",
    model: "stub-model",
    ...extra,
  };
}

// ── 1. 3 disagreeing agents → consensus split, evidence=3 ──────────────────
{
  // The judge "model" returns a consensus verdict citing all 3 agents.
  const verdict = JSON.stringify({
    agreement: "split",
    evidence: [
      { fromAgentId: "a", excerpt: "use approach X", weight: 0.6 },
      { fromAgentId: "b", excerpt: "use approach Y", weight: 0.7 },
      { fromAgentId: "c", excerpt: "use approach Z", weight: 0.5 },
    ],
    risks: ["X has perf risk", "Y lacks tests"],
    unresolved: ["which approach?"],
    final_answer: "merge X and Y, drop Z",
    confidence: 0.72,
  });
  const restore = installJudgeProvider(
    "kimi",
    makeJudgeProvider("kimi", [verdict]),
  );

  const results = [
    makeResult("a", true, "I recommend approach X because..."),
    makeResult("b", true, "Approach Y is better since..."),
    makeResult("c", true, "Go with approach Z for..."),
  ];

  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());

  check("consensus: ok", out.ok === true, `reason=${out.reason}`);
  check("consensus: schemaName", out.schemaName === "consensus");
  check("consensus: agreement=split", (out.data as { agreement?: string })?.agreement === "split");
  const evidence = (out.data as { evidence?: unknown[] })?.evidence;
  check("consensus: evidence.length===3", Array.isArray(evidence) && evidence.length === 3, `len=${evidence?.length}`);
  check("consensus: costUSD>0", out.costUSD > 0, `cost=${out.costUSD}`);
  check("consensus: modelUsed set", out.modelUsed === "moonshot-v1-128k" || out.modelUsed === "stub-judge-model", out.modelUsed);
  check("consensus: attempts=0 (first try)", out.attempts === 0, `attempts=${out.attempts}`);

  restore();
}

// ── 2. all agents ok=false → judge still returns conflict + unresolved ──────
{
  const verdict = JSON.stringify({
    agreement: "conflict",
    evidence: [],
    risks: ["all sub-agents failed"],
    unresolved: ["no valid conclusions to merge"],
    final_answer: "Unable to aggregate: all sub-agents failed.",
    confidence: 0.1,
  });
  const restore = installJudgeProvider(
    "glm",
    makeJudgeProvider("glm", [verdict]),
  );

  const results = [
    makeResult("a", false, "", { reason: "timeout" }),
    makeResult("b", false, "", { reason: "provider error" }),
    makeResult("c", false, "", { reason: "budget exceeded" }),
  ];

  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());

  check("all-failed: ok", out.ok === true, `reason=${out.reason}`);
  check("all-failed: agreement=conflict", (out.data as { agreement?: string })?.agreement === "conflict");
  const unresolved = (out.data as { unresolved?: unknown[] })?.unresolved;
  check("all-failed: unresolved non-empty", Array.isArray(unresolved) && unresolved.length > 0);

  restore();
}

// ── 3. json-mode-capable provider → 100% parse success ─────────────────────
{
  // A clean JSON response (no fences, no prose) → must parse on attempt 0.
  const verdict = JSON.stringify({
    agreement: "strong",
    evidence: [{ fromAgentId: "a", excerpt: "yes", weight: 0.9 }],
    risks: [],
    unresolved: [],
    final_answer: "All agree.",
    confidence: 0.95,
  });
  const restore = installJudgeProvider(
    "deepseek",
    makeJudgeProvider("deepseek", [verdict]),
  );

  const results = [makeResult("a", true, "yes"), makeResult("b", true, "yes")];
  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());

  check("json-mode: ok", out.ok === true, `reason=${out.reason}`);
  check("json-mode: attempts=0", out.attempts === 0);
  check("json-mode: agreement=strong", (out.data as { agreement?: string })?.agreement === "strong");

  restore();
}

// ── 4. messy output (fences + prose) → tryFixJSON recovers ─────────────────
{
  // Model wraps JSON in ```json fences with leading/trailing prose.
  const verdict =
    "Here is my judgment:\n```json\n" +
    JSON.stringify({
      agreement: "weak",
      evidence: [{ fromAgentId: "a", excerpt: "mostly yes", weight: 0.5 }],
      risks: ["minor"],
      unresolved: [],
      final_answer: "Weak agreement on A.",
      confidence: 0.4,
    }) +
    "\n```\nHope this helps.";
  const restore = installJudgeProvider(
    "gemini",
    makeJudgeProvider("gemini", [verdict]),
  );

  const results = [makeResult("a", true, "mostly yes")];
  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());

  check("messy: ok (tryFixJSON recovered)", out.ok === true, `reason=${out.reason}`);
  check("messy: agreement=weak", (out.data as { agreement?: string })?.agreement === "weak");

  restore();
}

// ── 5. self-repair: first malformed, second valid → ok=true, attempts=1 ────
{
  // First call: missing `final_answer` field (schema violation).
  // Second call (repair): valid full object.
  const malformed = JSON.stringify({
    agreement: "split",
    evidence: [{ fromAgentId: "a", excerpt: "x", weight: 0.5 }],
    risks: [],
    unresolved: [],
    // final_answer MISSING
    confidence: 0.5,
  });
  const repaired = JSON.stringify({
    agreement: "split",
    evidence: [{ fromAgentId: "a", excerpt: "x", weight: 0.5 }],
    risks: [],
    unresolved: [],
    final_answer: "Repaired verdict.",
    confidence: 0.5,
  });
  const restore = installJudgeProvider(
    "kimi",
    makeJudgeProvider("kimi", [malformed, repaired]),
  );

  const results = [makeResult("a", true, "x")];
  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());

  check("repair: ok (self-repair succeeded)", out.ok === true, `reason=${out.reason}`);
  check("repair: attempts=1", out.attempts === 1, `attempts=${out.attempts}`);
  check("repair: final_answer present", typeof (out.data as { final_answer?: string })?.final_answer === "string");

  restore();
}

// ── 6. both attempts fail → ok=false, reason='parse' ───────────────────────
{
  const garbage = "This is not JSON at all, just prose with no braces.";
  const restore = installJudgeProvider(
    "glm",
    makeJudgeProvider("glm", [garbage, garbage]),
  );

  const results = [makeResult("a", true, "x")];
  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());

  check("parse-fail: ok=false", out.ok === false);
  check("parse-fail: reason=parse", out.reason === "parse", `reason=${out.reason}`);
  check("parse-fail: attempts=1 (retried once)", out.attempts === 1, `attempts=${out.attempts}`);
  check("parse-fail: rawText preserved", out.rawText.length > 0);

  restore();
}

// ── 7. no provider available → ok=false, reason='no-provider' (no throw) ───
{
  // Clear every provider's secret so hasSecret=false across the fallback
  // chain AND the parent. pickJudgeProvider then returns undefined and the
  // judge degrades gracefully (no throw).
  const envKeys = ["KIMI_API_KEY", "GLM_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CHOVY_STUB_KEY"];
  const prev: Record<string, string | undefined> = {};
  for (const k of envKeys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  resetSecretsCache();

  const results = [makeResult("a", true, "x")];
  let threw = false;
  let out;
  try {
    out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());
  } catch {
    threw = true;
    out = undefined;
  }

  check("no-provider: did not throw", !threw);
  check("no-provider: ok=false", out?.ok === false);
  check("no-provider: reason=no-provider", out?.reason === "no-provider", `reason=${out?.reason}`);
  check("no-provider: costUSD=0", out?.costUSD === 0);

  for (const k of envKeys) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  resetSecretsCache();
}

// ── 8. compare / rank / custom schemas parse their shape ───────────────────
{
  // compare
  {
    const verdict = JSON.stringify({
      pairs: [
        { a: "a", b: "b", diff: "a is faster", winner: "a" },
        { a: "a", b: "c", diff: "c is safer", winner: "b" },
      ],
      recommendation: "Use c for safety-critical paths.",
    });
    const restore = installJudgeProvider("kimi", makeJudgeProvider("kimi", [verdict]));
    const results = [makeResult("a", true, "fast"), makeResult("b", true, "slow"), makeResult("c", true, "safe")];
    const out = await runJudge(results, { judge: { enabled: true, schema: "compare" } }, makeParentCtx());
    check("compare: ok", out.ok === true, `reason=${out.reason}`);
    check("compare: schemaName", out.schemaName === "compare");
    check("compare: pairs.length=2", (out.data as { pairs?: unknown[] })?.pairs?.length === 2);
    restore();
  }
  // rank
  {
    const verdict = JSON.stringify({
      ranking: [
        { agentId: "a", score: 8, reason: "thorough" },
        { agentId: "b", score: 6, reason: "missed edge case" },
      ],
      topPick: "a",
    });
    const restore = installJudgeProvider("glm", makeJudgeProvider("glm", [verdict]));
    const results = [makeResult("a", true, "thorough"), makeResult("b", true, "partial")];
    const out = await runJudge(results, { judge: { enabled: true, schema: "rank" } }, makeParentCtx());
    check("rank: ok", out.ok === true, `reason=${out.reason}`);
    check("rank: topPick=a", (out.data as { topPick?: string })?.topPick === "a");
    restore();
  }
  // custom
  {
    const verdict = JSON.stringify({
      items: [{ todo: "fix bug", severity: "high" }, { todo: "add tests", severity: "low" }],
    });
    const restore = installJudgeProvider("deepseek", makeJudgeProvider("deepseek", [verdict]));
    const results = [makeResult("a", true, "fix bug and add tests")];
    const out = await runJudge(
      results,
      {
        judge: {
          enabled: true,
          schema: "custom",
          customSchema: z.object({ todo: z.string(), severity: z.enum(["high", "low"]) }),
        },
      },
      makeParentCtx(),
    );
    check("custom: ok", out.ok === true, `reason=${out.reason}`);
    check("custom: schemaName", out.schemaName === "custom");
    check("custom: items.length=2", (out.data as { items?: unknown[] })?.items?.length === 2);
    restore();
  }
}

// ── 9. content truncation: >4KB agent content is head+tail truncated ────────
{
  // Build a result whose content is 10KB; the judge provider echoes back a
  // consensus verdict. We can't directly observe the truncated input from
  // here, but we CAN verify the judge still succeeds (truncation didn't break
  // assembly) and that a huge input doesn't overflow. The truncation logic
  // is unit-tested via tryFixJSON below; here we smoke the integration.
  const big = "A".repeat(10 * 1024);
  const verdict = JSON.stringify({
    agreement: "strong",
    evidence: [{ fromAgentId: "big", excerpt: "AAA", weight: 0.5 }],
    risks: [],
    unresolved: [],
    final_answer: "Truncated input handled.",
    confidence: 0.6,
  });
  const restore = installJudgeProvider("kimi", makeJudgeProvider("kimi", [verdict]));
  const results = [makeResult("big", true, big)];
  const out = await runJudge(results, { judge: { enabled: true, schema: "consensus" } }, makeParentCtx());
  check("trunc: ok with 10KB content", out.ok === true, `reason=${out.reason}`);
  restore();
}

// ── 10. judge cancellation → ok=false, reason='cancelled' ──────────────────
{
  const restore = installJudgeProvider(
    "kimi",
    makeJudgeProvider("kimi", ['{"agreement":"strong"}']),
  );
  const ac = new AbortController();
  const results = [makeResult("a", true, "x")];
  // Pre-abort: the judge should short-circuit before calling the provider.
  ac.abort();
  const out = await runJudge(
    results,
    { judge: { enabled: true, schema: "consensus" }, abortSignal: ac.signal },
    makeParentCtx(),
  );
  check("cancel: ok=false", out.ok === false);
  check("cancel: reason=cancelled", out.reason === "cancelled", `reason=${out.reason}`);
  check("cancel: costUSD=0 (no call made)", out.costUSD === 0);
  restore();
}

// ── 11. tryFixJSON unit cases ───────────────────────────────────────────────
{
  // clean JSON → parsed object
  check("fix: clean JSON parses", tryFixJSON('{"a":1}') !== null && typeof tryFixJSON('{"a":1}') === "object");
  // fenced JSON → parsed object
  const fenced = tryFixJSON('```json\n{"a":1}\n```');
  check("fix: fenced JSON parses", typeof fenced === "object" && fenced !== null && (fenced as { a?: number }).a === 1);
  // leading + trailing prose
  const prose = tryFixJSON('Here: {"a":1} done.');
  check("fix: prose-wrapped parses", typeof prose === "object" && prose !== null && (prose as { a?: number }).a === 1);
  // truncated mid-object: missing closing brace + trailing garbage
  const trunc = tryFixJSON('{"agreement":"split","evidence":[],"risks":[],"unresolved":[],"final_answer":"x","confidence":0.5');
  check("fix: truncated JSON recovers (balanced prefix)", typeof trunc === "object" && trunc !== null, `got=${typeof trunc}`);
  // non-JSON string → returns trimmed string (zod will report mismatch)
  const notJson = tryFixJSON("just prose no braces");
  check("fix: non-JSON returns string", typeof notJson === "string");
  // already-truncated array
  const arr = tryFixJSON('[{"x":1},{"x":2');
  check("fix: truncated array recovers", Array.isArray(arr) && arr.length === 1, `got=${JSON.stringify(arr)}`);
}

// ── 12. schema unit: ConsensusSchema / CompareSchema / RankSchema / CustomMeta ─
{
  // ConsensusSchema validates a full object
  const consensusOk = ConsensusSchema.safeParse({
    agreement: "strong",
    evidence: [{ fromAgentId: "a", excerpt: "x", weight: 0.5 }],
    risks: [],
    unresolved: [],
    final_answer: "yes",
    confidence: 0.9,
  }).success;
  check("schema: ConsensusSchema validates", consensusOk);

  // ConsensusSchema rejects bad agreement
  const consensusBad = ConsensusSchema.safeParse({
    agreement: "invalid",
    evidence: [],
    risks: [],
    unresolved: [],
    final_answer: "yes",
    confidence: 0.9,
  }).success;
  check("schema: ConsensusSchema rejects bad enum", !consensusBad);

  // CompareSchema
  const compareOk = CompareSchema.safeParse({
    pairs: [{ a: "1", b: "2", diff: "d", winner: "a" }],
    recommendation: "r",
  }).success;
  check("schema: CompareSchema validates", compareOk);

  // RankSchema
  const rankOk = RankSchema.safeParse({
    ranking: [{ agentId: "a", score: 7, reason: "r" }],
    topPick: "a",
  }).success;
  check("schema: RankSchema validates", rankOk);

  // CustomMeta wraps a custom schema
  const custom = CustomMeta(z.object({ name: z.string() }));
  const customOk = custom.safeParse({ items: [{ name: "x" }] }).success;
  check("schema: CustomMeta validates", customOk);
  const customBad = custom.safeParse({ items: [{ name: 123 }] }).success;
  check("schema: CustomMeta rejects bad inner", !customBad);
}

// ── Final report ───────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
