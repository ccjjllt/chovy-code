/**
 * Judge aggregator (step-21).
 *
 * The "referee model" half of SwarmR (`docs/innovations.md §2 SwarmR`). After
 * `dispatch()` (step-20) collects N sub-agent results, the judge feeds them
 * to a (separately configured) provider, constrains the output to one of four
 * zod schemas, and returns a `JudgedAggregate` that the main agent reads as
 * a structured verdict alongside the raw results.
 *
 * Flow (`docs/step-21-judge-aggregator.md §流程`):
 *   1. assemble the input — wrap each result in
 *      `<agent id="…" role="…" status="…"><content>…</content></agent>` so the
 *      judge can attribute evidence to specific agents;
 *   2. truncate per-agent content to ≤ 4 KB (head + tail preserved) when the
 *      combined input would blow the model's context window — the prompt
 *      tells the model it has been truncated;
 *   3. pick the judge provider/model: caller override → availability fallback
 *      chain (long-context first: Kimi-K2 → GLM-4.5 → DeepSeek-V3 →
 *      Gemini-1.5-pro → Claude Sonnet 4);
 *   4. one `provider.complete()` call, then `tryFixJSON` (strip ``` fences /
 *      trailing truncation / leading prose) and `zod.safeParse`;
 *   5. on parse failure, ONE self-repair retry with a repair prompt that
 *      echoes the parse error;
 *   6. still failing → return `{ ok:false, rawText, data:undefined }`.
 *
 * Telemetry invariant (AGENTS.md §18): the judge is NOT a telemetry source.
 * `swarm.dispatch` is the single event per dispatch (router emits it once).
 * Judge cost is folded into the dispatch's `totalCostUSD` but no separate
 * `judge.*` telemetry event is emitted. Failure does NOT change
 * `DispatchOutput.stopReason` — the judge's verdict rides the `judgement`
 * field with `ok=false` (§18 "Judge 留桩不变量" carried forward).
 *
 * Cancellation (AGENTS.md §9): the judge builds its OWN local
 * AbortController wrapping the caller's signal (never shares the parent
 * dispatch's signal object). An aborted judge returns `ok:false` with
 * `reason:'cancelled'` rather than throwing — the router already decided
 * `stopReason`; we don't escalate.
 */
import { z } from "zod";

import { logger } from "../logger/index.js";
import { ChovyError } from "../types/errors.js";
import { getProvider } from "../providers/index.js";
import { hasSecret } from "../config/secrets.js";
import { getCapability } from "../providers/capabilities.js";
import {
  CostTracker,
  type TokenUsage,
} from "../engine/costTracker.js";
import type {
  ChatMessage,
  Provider,
  ProviderId,
} from "../types/index.js";
import type { ParentRuntimeCtx } from "../types/index.js";
import {
  schemaFor,
  type JudgeSchemaNameLike,
} from "./schemas.js";
import type {
  DispatchChildResult,
  DispatchJudgeOptions,
  JudgeSchemaName,
} from "./router.js";

// ── public types ───────────────────────────────────────────────────────────

/**
 * Structured judge verdict handed back to the main agent via
 * `DispatchOutput.judgement`. `ok:false` means the judge ran but could not
 * produce schema-valid output (model returned unparseable JSON, aborted, or
 * the provider was unavailable); `data` is then `undefined` and `rawText`
 * carries the last model response for debugging.
 */
export interface JudgedAggregate<T = unknown> {
  schemaName: JudgeSchemaName;
  /** True iff `data` is a zod-parsed object matching `schemaName`. */
  ok: boolean;
  /** zod-parsed judge output; `undefined` when `ok === false`. */
  data?: T;
  /** Last raw model response (post-tryFixJSON attempt). Debug surface. */
  rawText: string;
  /** Judge-call USD spend (marginal, not cumulative dispatch cost). */
  costUSD: number;
  /** Provider/model that actually answered. */
  modelUsed: string;
  providerUsed: ProviderId;
  /** Absent-reason when `ok === false` ('parse' / 'cancelled' / 'no-provider'). */
  reason?: string;
  /** 0 = first attempt, 1 = self-repair retry. */
  attempts: number;
}

// ── constants ──────────────────────────────────────────────────────────────

/**
 * Per-agent content cap when assembling judge input. The combined transcript
 * of N sub-agents can easily exceed a 128k window; we truncate each agent's
 * content to 4 KB (head + tail preserved) and tell the model it's truncated.
 * Per `docs/step-21 §风险`.
 */
const PER_AGENT_CONTENT_BYTES = 4 * 1024;
/** Head/tail split when truncating (keep first + last slice). */
const TRUNCATE_HEAD_BYTES = 2 * 1024;
const TRUNCATE_TAIL_BYTES = 2 * 1024;

/** Max output tokens the judge may emit. JSON verdicts are short. */
const JUDGE_MAX_TOKENS = 2048;

/**
 * Judge provider fallback chain (long-context first), per
 * `docs/step-21 §默认 judge provider`. We prefer models whose context window
 * comfortably holds N sub-agent transcripts; the caller can override with
 * `dispatch.judge.provider/model`.
 *
 * Each entry is the (providerId, defaultModelId) the judge falls back to when
 * the caller omits an override AND the provider is configured (has a secret).
 */
const PROVIDER_FALLBACK: ReadonlyArray<{ provider: ProviderId; model: string }> = [
  { provider: "kimi", model: "moonshot-v1-128k" },
  { provider: "deepseek", model: "deepseek-chat" },
  { provider: "alibaba", model: "qwen-max" },
  { provider: "zhipu", model: "glm-4.6" },
  { provider: "openai", model: "gpt-4o" },
];

// ── main entry ─────────────────────────────────────────────────────────────

export interface RunJudgeOptions {
  judge: DispatchJudgeOptions;
  /** Caller-controlled cancellation (the dispatch's local AC). */
  abortSignal?: AbortSignal;
}

/**
 * Run the judge over `results`. Returns a `JudgedAggregate` (never throws —
 * a judge failure is surfaced via `ok:false` so the router keeps
 * `stopReason='final'` per §18).
 *
 * `parentCtx` seeds the provider/model defaults: when the caller omits
 * `judge.provider`/`judge.model`, the judge walks the fallback chain for a
 * *configured* provider; if none is configured it falls back to the parent's
 * provider/model (best-effort — the parent run obviously had a working key).
 */
export async function runJudge(
  results: DispatchChildResult[],
  opts: RunJudgeOptions,
  parentCtx: ParentRuntimeCtx,
): Promise<JudgedAggregate> {
  const schemaName = opts.judge.schema;
  const schema = schemaFor(
    schemaName as JudgeSchemaNameLike,
    opts.judge.customSchema,
  );

  const providerPick = pickJudgeProvider(opts.judge, parentCtx);

  // No usable provider → degrade gracefully (§18: judge failure is not a
  // dispatch failure). The main agent still gets the raw results.
  if (!providerPick) {
    logger.warn("judge: no provider available; skipping", { schema: schemaName });
    return {
      schemaName,
      ok: false,
      rawText: "",
      costUSD: 0,
      modelUsed: parentCtx.parentModel,
      providerUsed: parentCtx.parentProvider,
      reason: "no-provider",
      attempts: 0,
    };
  }

  const { provider, providerId, model } = providerPick;

  // Local AbortController wrapping the caller's signal (AGENTS.md §9). The
  // judge never shares the dispatch's signal object; an external abort flips
  // the judge to `ok:false / reason:'cancelled'` without throwing.
  const ac = new AbortController();
  let cancelled = false;
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      cancelled = true;
      ac.abort();
    } else {
      const onAbort = (): void => {
        cancelled = true;
        ac.abort();
      };
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
      ac.signal.addEventListener(
        "abort",
        () => opts.abortSignal!.removeEventListener("abort", onAbort),
        { once: true },
      );
    }
  }

  if (cancelled) {
    return {
      schemaName,
      ok: false,
      rawText: "",
      costUSD: 0,
      modelUsed: model,
      providerUsed: providerId,
      reason: "cancelled",
      attempts: 0,
    };
  }

  const promptText = loadPrompt(schemaName);
  const assembledInput = assembleInput(results);
  const systemPrompt = buildSystemPrompt(promptText, schema, assembledInput);

  const tracker = new CostTracker({ agentId: "judge", telemetry: false });
  let lastRaw = "";
  let lastError: z.ZodError | undefined;
  let attempts = 0;

  // Two attempts: 0 = first call, 1 = self-repair retry. The repair prompt
  // echoes the previous raw output + the zod parse error so the model can
  // fix the specific shape violation.
  for (let attempt = 0; attempt <= 1; attempt++) {
    attempts = attempt;
    if (ac.signal.aborted) {
      return {
        schemaName,
        ok: false,
        rawText: lastRaw,
        costUSD: tracker.total().usd,
        modelUsed: model,
        providerUsed: providerId,
        reason: "cancelled",
        attempts,
      };
    }

    const userMessage = attempt === 0
      ? buildFirstUserMessage(assembledInput)
      : buildRepairUserMessage(assembledInput, lastRaw, lastError);

    try {
      const completion = await callProvider(
        provider,
        providerId,
        model,
        systemPrompt,
        userMessage,
        ac.signal,
      );
      // Record cost (best-effort; missing usage → 0).
      if (completion.usage) {
        tracker.record(providerId, model, toTokenUsage(completion.usage));
      }
      lastRaw = completion.content ?? "";

      const fixed = tryFixJSON(lastRaw);
      const parsed = schema.safeParse(fixed);
      if (parsed.success) {
        return {
          schemaName,
          ok: true,
          data: parsed.data,
          rawText: lastRaw,
          costUSD: tracker.total().usd,
          modelUsed: model,
          providerUsed: providerId,
          attempts,
        };
      }
      lastError = parsed.error;
      logger.warn("judge: schema parse failed", {
        attempt,
        schema: schemaName,
        issues: parsed.error.issues.length,
      });
    } catch (err) {
      // Provider failure on attempt 0 → try repair with a fresh call. On
      // attempt 1 we give up. AbortError → cancelled, not parse failure.
      const aborted = isAbortError(err);
      if (aborted) {
        return {
          schemaName,
          ok: false,
          rawText: lastRaw,
          costUSD: tracker.total().usd,
          modelUsed: model,
          providerUsed: providerId,
          reason: "cancelled",
          attempts,
        };
      }
      lastError = undefined;
      lastRaw = lastRaw || "";
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("judge: provider call failed", { attempt, error: msg });
      // If the provider itself is unavailable (assertReady / 4xx), retrying
      // with a repair prompt won't help — but the spec says "retry once", so
      // we still attempt the repair pass for transient errors.
    }
  }

  return {
    schemaName,
    ok: false,
    rawText: lastRaw,
    costUSD: tracker.total().usd,
    modelUsed: model,
    providerUsed: providerId,
    reason: "parse",
    attempts,
  };
}

// ── provider selection ─────────────────────────────────────────────────────

interface ProviderPick {
  provider: Provider;
  providerId: ProviderId;
  model: string;
}

/**
 * Resolve the judge provider/model.
 *
 * Precedence:
 *   1. caller `judge.provider` + `judge.model` (explicit override) — used
 *      verbatim if the provider is registered; the caller is responsible for
 *      having a key. Falls through to the fallback chain when the override
 *      names an unregistered provider.
 *   2. fallback chain (long-context first) — first entry whose provider has
 *      a configured secret. `judge.model` (if set) overrides the chain's
 *      default model id for the chosen provider.
 *   3. parent provider/model — last resort; the parent run had a working key.
 */
function pickJudgeProvider(
  judge: DispatchJudgeOptions,
  parentCtx: ParentRuntimeCtx,
): ProviderPick | undefined {
  // 1. Explicit override.
  if (judge.provider) {
    try {
      const provider = getProvider(judge.provider);
      // Don't assertReady here — a missing key should fall through to the
      // chain rather than throw. hasSecret is the cheap check.
      if (hasSecret(judge.provider)) {
        const model = judge.model ?? defaultModelFor(judge.provider);
        return { provider, providerId: judge.provider, model };
      }
    } catch {
      // unregistered provider id → fall through
    }
  }

  // 2. Fallback chain.
  for (const entry of PROVIDER_FALLBACK) {
    if (!hasSecret(entry.provider)) continue;
    try {
      const provider = getProvider(entry.provider);
      // caller model override wins over chain default
      const model = judge.model ?? entry.model;
      return { provider, providerId: entry.provider, model };
    } catch {
      continue;
    }
  }

  // 3. Parent provider (best-effort; it ran the dispatch). Only chosen when
  //    the parent actually has a configured key — otherwise we'd call a
  //    provider whose `assertReady()` throws, which surfaces as a confusing
  //    `reason:'parse'` instead of the honest `reason:'no-provider'`.
  if (hasSecret(parentCtx.parentProvider)) {
    try {
      const provider = getProvider(parentCtx.parentProvider);
      const model = judge.model ?? parentCtx.parentModel;
      return {
        provider,
        providerId: parentCtx.parentProvider,
        model,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Default model id for a provider (from the registry's ProviderInfo). */
function defaultModelFor(providerId: ProviderId): string {
  try {
    return getProvider(providerId).info.defaultModel;
  } catch {
    return "gpt-4o-mini";
  }
}

// ── input assembly ─────────────────────────────────────────────────────────

interface AssembledInput {
  /** XML-wrapped agent blocks, truncated per PER_AGENT_CONTENT_BYTES. */
  blocks: string[];
  /** True iff any agent content was truncated. */
  truncated: boolean;
  /** Number of agents with ok=false (the judge prompt mentions this). */
  failedCount: number;
  total: number;
}

function assembleInput(results: DispatchChildResult[]): AssembledInput {
  const blocks: string[] = [];
  let truncated = false;
  let failedCount = 0;
  for (const r of results) {
    if (!r.ok) failedCount++;
    const role = r.status; // reuse status as a coarse role hint for the judge
    const content = truncateContent(r.content ?? "");
    if (content.truncated) truncated = true;
    blocks.push(
      `<agent id="${escAttr(r.id)}" role="${escAttr(role)}" status="${escAttr(r.ok ? "ok" : "failed")}">` +
        `<content>${escXml(content.text)}</content>` +
        `</agent>`,
    );
  }
  return { blocks, truncated, failedCount, total: results.length };
}

interface TruncatedContent {
  text: string;
  truncated: boolean;
}

/**
 * Truncate to ≤ PER_AGENT_CONTENT_BYTES, preserving head + tail so the judge
 * sees both the opening framing and the final conclusion. Per step-21 §风险.
 */
function truncateContent(content: string): TruncatedContent {
  if (Buffer.byteLength(content, "utf8") <= PER_AGENT_CONTENT_BYTES) {
    return { text: content, truncated: false };
  }
  const head = sliceBytes(content, 0, TRUNCATE_HEAD_BYTES);
  const tail = sliceBytes(
    content,
    Buffer.byteLength(content, "utf8") - TRUNCATE_TAIL_BYTES,
  );
  return {
    text: `${head}\n…[truncated]…\n${tail}`,
    truncated: true,
  };
}

/** Slice a string by UTF-8 byte offsets (surrogate-safe at the edges). */
function sliceBytes(s: string, startByte: number, endByte?: number): string {
  const buf = Buffer.from(s, "utf8");
  const sliced = endByte === undefined
    ? buf.subarray(startByte)
    : buf.subarray(startByte, endByte);
  return sliced.toString("utf8");
}

// ── prompt building ────────────────────────────────────────────────────────

/**
 * Load the schema-specific judge prompt. Bundled as sibling .txt files so a
 * future step can hot-swap them without a code change; we inline them here
 * (mirroring `src/swarm/prompts/*.txt`) so the judge has zero fs/runtime
 * dependencies and is self-contained for tests / bundling. The .txt files
 * are the canonical, human-editable source — keep the two in sync (a drift
 * check lives in the step-21 smoke harness).
 */
function loadPrompt(schemaName: JudgeSchemaName): string {
  switch (schemaName) {
    case "consensus":
      return CONSENSUS_PROMPT;
    case "compare":
      return COMPARE_PROMPT;
    case "rank":
      return RANK_PROMPT;
    case "custom":
      return META_PROMPT;
    default:
      return CONSENSUS_PROMPT;
  }
}

function buildSystemPrompt(
  promptText: string,
  schema: z.ZodTypeAny,
  input: AssembledInput,
): string {
  const schemaStr = stringifySchema(schema);
  const lines: string[] = [promptText];
  lines.push("");
  lines.push("## 输出 schema（必须严格匹配，字段名一字不差）");
  lines.push("```json");
  lines.push(schemaStr);
  lines.push("```");
  lines.push("");
  lines.push(
    `## 输入概况：共 ${input.total} 个子 agent` +
      (input.failedCount > 0
        ? `，其中 ${input.failedCount} 个失败（content 可能为空或为错误说明）`
        : "") +
      (input.truncated ? "；部分 agent 内容已截断（标注 …[truncated]…）" : "") +
      "。",
  );
  lines.push(
    "失败的 agent 不应被忽略——在 evidence/unresolved 中标注它们，并在 risks 中记录。",
  );
  return lines.join("\n");
}

function buildFirstUserMessage(input: AssembledInput): string {
  return input.blocks.join("\n");
}

function buildRepairUserMessage(
  input: AssembledInput,
  lastRaw: string,
  error: z.ZodError | undefined,
): string {
  const lines: string[] = [];
  lines.push("## 上次输出未通过 schema 校验，请修复后重新输出。");
  lines.push("");
  lines.push("### 上次输出");
  lines.push("```");
  lines.push(lastRaw || "(empty)");
  lines.push("```");
  if (error) {
    lines.push("");
    lines.push("### 校验错误");
    for (const issue of error.issues.slice(0, 10)) {
      lines.push(
        `- path [${issue.path.join(".")}]: ${issue.message} (code: ${issue.code})`,
      );
    }
    if (error.issues.length > 10) {
      lines.push(`- …还有 ${error.issues.length - 10} 条错误`);
    }
  }
  lines.push("");
  lines.push("### 原始输入（再供参考）");
  lines.push(input.blocks.join("\n"));
  lines.push("");
  lines.push("请只输出修正后的 JSON，不要解释。");
  return lines.join("\n");
}

/**
 * Render a zod schema as a JSON-Schema-ish string the model can read. We use
 * zod's `.toJSON()` (available in zod 3) when present; otherwise fall back to
 * a minimal description. The string is for the model's benefit — the actual
 * validation runs through `schema.safeParse`.
 */
function stringifySchema(schema: z.ZodTypeAny): string {
  const maybeJson = schema as unknown as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === "function") {
    try {
      return JSON.stringify(maybeJson.toJSON(), null, 2);
    } catch {
      /* fall through */
    }
  }
  // zod 3.23 ships _def.description; minimal fallback.
  try {
    return JSON.stringify(
      { description: (schema as { description?: string }).description ?? "object" },
      null,
      2,
    );
  } catch {
    return "{}";
  }
}

// ── provider call ──────────────────────────────────────────────────────────

async function callProvider(
  provider: Provider,
  providerId: ProviderId,
  model: string,
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
): Promise<{ content: string; usage?: { prompt: number; completion: number } }> {
  provider.assertReady();
  const cap = safeGetCapability(providerId);
  const messages: ChatMessage[] = [
    { role: "user", content: userMessage, ts: Date.now() },
  ];

  // When the provider supports json-mode natively (OpenAI-family response_format
  // or equivalent), the adapter turns it on via an empty toolSpec-free request
  // with the system prompt strongly demanding JSON. We don't have a first-class
  // `response_format` knob on ProviderRequestOptions, so we rely on the prompt
  // constraint + tryFixJSON post-processing (the spec's "否则仅约束 + 后处理"
  // path). jsonMode-capable providers still benefit because the prompt is
  // explicit and we strip fences.
  void cap;

  const completion = await provider.complete({
    model,
    messages,
    systemPrompt,
    temperature: 0, // deterministic verdict
    maxTokens: JUDGE_MAX_TOKENS,
    signal,
  });
  return {
    content: completion.content,
    usage: completion.usage,
  };
}

function safeGetCapability(providerId: ProviderId): {
  supportsJsonMode: boolean;
  contextWindow: number;
} | undefined {
  try {
    const cap = getCapability(providerId);
    return {
      supportsJsonMode: cap.supportsJsonMode,
      contextWindow: cap.contextWindow,
    };
  } catch {
    return undefined;
  }
}

function toTokenUsage(
  usage: { prompt: number; completion: number },
): TokenUsage {
  return { in: usage.prompt, out: usage.completion };
}

// ── JSON repair ────────────────────────────────────────────────────────────

/**
 * Best-effort repair of a model's JSON output. Steps (each defensive — a step
 * that doesn't apply is a no-op):
 *   1. strip ```json / ``` code-fence wrappers;
 *   2. trim leading prose before the first `{` or `[`;
 *   3. trim trailing prose after the last `}` or `]`;
 *   4. if truncated mid-object (unbalanced braces), cut at the last balanced
 *      closing brace so partial JSON still parses where possible;
 *   5. JSON.parse → if it succeeds, return the object; if not, return the
 *      trimmed string so zod can report the real shape issue.
 *
 * Returns the parsed value when JSON.parse succeeds (zod then validates the
 * object); otherwise returns the repaired string (zod will report a type
 * mismatch, which is the honest signal).
 */
export function tryFixJSON(raw: string): unknown {
  if (typeof raw !== "string") return raw;
  let s = raw.trim();

  // 1. Strip ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fence && fence[1] !== undefined) s = fence[1].trim();

  // 2. Leading prose: drop everything before the first { or [.
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  if (firstObj !== -1 && firstArr !== -1) start = Math.min(firstObj, firstArr);
  else if (firstObj !== -1) start = firstObj;
  else if (firstArr !== -1) start = firstArr;
  if (start > 0) s = s.slice(start);

  // 3. Trailing prose: drop everything after the last } or ].
  const lastObj = s.lastIndexOf("}");
  const lastArr = s.lastIndexOf("]");
  let end = -1;
  if (lastObj !== -1 && lastArr !== -1) end = Math.max(lastObj, lastArr);
  else if (lastObj !== -1) end = lastObj;
  else if (lastArr !== -1) end = lastArr;
  if (end !== -1 && end < s.length - 1) s = s.slice(0, end + 1);

  // 4. Truncation repair: if braces are unbalanced, try two strategies:
  //    (a) cut at the last balanced closer (handles trailing garbage after a
  //        complete sub-object);
  //    (b) append the missing closers (handles truly truncated output where
  //        the model ran out of tokens mid-object/array). Strategy (b) tracks
  //    the open-brace stack and appends matching closers in reverse order.
  if (!isBalanced(s)) {
    const cut = cutAtLastBalanced(s);
    if (cut && isBalanced(cut)) {
      s = cut;
    } else {
      const closed = appendMissingClosers(s);
      if (closed && isBalanced(closed)) s = closed;
    }
  }

  // 5. Parse.
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function isBalanced(s: string): boolean {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Find the longest prefix of `s` that is brace-balanced, scanning from the
 * right for the earliest closing brace that balances. Returns null if no
 * balanced prefix exists.
 */
function cutAtLastBalanced(s: string): string | null {
  for (let i = s.length; i > 0; i--) {
    const candidate = s.slice(0, i);
    if (isBalanced(candidate)) {
      // Only accept if it actually ends in a closer (otherwise we'd return
      // a partial key/value).
      const last = candidate[candidate.length - 1];
      if (last === "}" || last === "]") return candidate;
    }
  }
  return null;
}

/**
 * Append the missing closing braces/brackets to a truncated JSON string.
 * Tracks the open-delimiter stack (ignoring string contents) and appends the
 * matching closer for each unclosed `{` / `[` in reverse (LIFO). Also trims a
 * trailing partial value (e.g. `"confidence":0.5` with no closer) by cutting
 * back to the last structural character that leaves a parseable prefix.
 *
 * This is a best-effort heuristic — when the truncation lands mid-string or
 * mid-key it may still fail to parse, in which case `tryFixJSON` returns the
 * raw string and zod reports the honest mismatch.
 */
function appendMissingClosers(s: string): string | null {
  const stack: Array<"{" | "["> = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") stack.push("{");
    else if (ch === "[") stack.push("[");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (stack.length === 0) return null;
  // If we ended inside a string, the last `"` never closed — we can't safely
  // append closers because the partial string would be invalid. Bail.
  if (inStr) return null;
  // Trim trailing partial value: if the string ends with an unterminated
  // value (e.g. `,"confidence":0.5`), the trailing fragment after the last
  // complete element may need a comma/structure fix. The cheapest repair is
  // to strip a trailing comma (if present) then append closers.
  let out = s.replace(/[\s,]+$/, "");
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === "{" ? "}" : "]";
  }
  return out;
}

// ── escaping ───────────────────────────────────────────────────────────────

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── errors ─────────────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string })?.name;
  if (name === "AbortError") return true;
  if (err instanceof ChovyError) return false; // ChovyError is never an abort
  return false;
}

// ── inlined prompt text (mirrors src/swarm/prompts/*.txt) ──────────────────
//
// The .txt files are the canonical, human-editable source. We inline them
// here so the judge has zero fs/runtime dependencies and is self-contained
// for tests / bundling. Keep the two in sync; a drift check lives in the
// step-21 smoke harness.

const CONSENSUS_PROMPT = `你是裁判模型。输入是 N 个子智能体（异构 provider）对同一问题的回答。
请按以下规则输出：
1. agreement: 子结论是否一致（strong/weak/split/conflict）；
2. evidence: 引用每个 agent 的关键句作为依据（fromAgentId + excerpt + weight 0–1）；
3. risks: 子结论中的潜在风险（≤10 条）；
4. unresolved: 仍未解决的问题（≤10 条）；
5. final_answer: 你的整合答案，假设你必须给用户一个明确回复；
6. confidence: 0–1 的置信度。

严格输出 JSON，不要 prose。不要包裹在 \`\`\`json 代码块中。
字段名必须与给定 schema 完全一致（agreement / evidence / risks / unresolved / final_answer / confidence）。`;

const COMPARE_PROMPT = `你是裁判模型。输入是 N 个子智能体对同一/相似问题的回答，你需要两两对比。
请按以下规则输出：
1. pairs: 选出需要对比的 agent 对（a / b 是 agentId），给出：
   - diff: 两者的关键差异（一句话）；
   - winner: a / b / tie（哪个更优，或平手）；
2. recommendation: 综合所有对比后给主 agent 的最终建议（明确指向一个方案或 agentId）。

严格输出 JSON，不要 prose。不要包裹在 \`\`\`json 代码块中。
字段名必须与给定 schema 完全一致（pairs / recommendation）。
pairs 内每个元素字段为 a / b / diff / winner。`;

const RANK_PROMPT = `你是裁判模型。输入是 N 个子智能体的回答，你需要为每个 agent 打分并排序。
请按以下规则输出：
1. ranking: 每个 agent 一项，字段：
   - agentId: 该 agent 的 id；
   - score: 0–10 的分数（综合正确性 / 完整性 / 风险意识）；
   - reason: 一句话理由；
2. topPick: 得分最高、最适合主 agent 采纳的 agentId。

严格输出 JSON，不要 prose。不要包裹在 \`\`\`json 代码块中。
字段名必须与给定 schema 完全一致（ranking / topPick）。
ranking 内每个元素字段为 agentId / score / reason。`;

const META_PROMPT = `你是裁判模型。输入是 N 个子智能体的回答，你需要从中抽取结构化条目。
请按以下规则输出：
1. items: 一个数组，每个元素是符合给定自定义 schema 的结构化记录。
   按需从各 agent 的回答中归并/去重/抽取，每条 items 对应一个独立结论或事实。

严格输出 JSON，不要 prose。不要包裹在 \`\`\`json 代码块中。
顶层字段只有一个 items（数组），数组内每个元素的字段由自定义 schema 决定。
如果没有任何可抽取的条目，返回 { "items": [] }。`;
