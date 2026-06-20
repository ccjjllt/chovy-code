/**
 * Convergence judge — rubric / command / hybrid evaluators (step-23).
 *
 * Three modes (per `docs/step-23-goal-loop.md §收敛判据`):
 *   - **rubric**:   call a small LLM with the rubric + transcript; expect
 *                   `{"ok":true}` or `{"ok":false,"reason":"..."}`. Reuses
 *                   `tryFixJSON` from `swarm/judge.ts` for parse robustness
 *                   (AGENTS.md §17 "Judge 五步修复" pattern).
 *   - **command**:  run a shell command via `bashTool.run()` and check the
 *                   exit code. Inherits the bash tool's hard-deny safety
 *                   floor (AGENTS.md §16 "L1g safety check"); the L2-L6
 *                   permission gates are skipped because the user explicitly
 *                   set this rubric and we're not going through the agent
 *                   loop.
 *   - **hybrid**:   command first (cheap + deterministic), then rubric only
 *                   if the command passed (LLM verifies the qualitative
 *                   side). Both must agree.
 *
 * Cancellation: each evaluation honors `opts.abortSignal` — rubric mode
 * forwards it to `provider.complete()`, command mode forwards it to
 * `bashTool.run` via the synthesized `ToolContext.abortSignal`. We do NOT
 * wrap a local AC here (the goal loop already wraps externally per §9);
 * the signal is purely passed through.
 *
 * Cost: rubric mode is the only mode that spends money. We use a fresh
 * `CostTracker({ telemetry: false })` so the cost is folded into the
 * goal's totalCostUSD without emitting a separate `agent.cost` event
 * (mirrors step-21 judge cost folding).
 */
import { logger } from "../logger/index.js";
import { CostTracker } from "../engine/costTracker.js";
import { getProvider } from "../providers/index.js";
import { hasSecret } from "../config/secrets.js";
import { loadConfig } from "../config/index.js";
import { projectId as deriveProjectId } from "../fs/paths.js";
import { bashTool } from "../tools/exec/bash.js";
import { tryFixJSON } from "../swarm/judge.js";
import { createHookEngine } from "../harness/hooks/index.js";
import type {
  ChatMessage,
  GoalState,
  ProviderId,
  ToolContext,
  ToolResult,
} from "../types/index.js";

// ── Public surface ─────────────────────────────────────────────────────────

export interface EvaluateOptions {
  /** Working directory for command mode + provider context. */
  cwd: string;
  /** Parent provider/model — fallback for rubric mode if no override on goal. */
  parentProvider: ProviderId;
  parentModel: string;
  /** Caller-controlled cancellation. */
  abortSignal?: AbortSignal;
  /** When true, skip rubric mode (used by command-only smoke / debugging). */
  skipRubric?: boolean;
}

export interface EvaluateResult {
  /** True when the convergence judge agreed the goal is done. */
  ok: boolean;
  /** Human-readable reasons (failures only). One per failed sub-check. */
  reasons: string[];
  /** USD cost of this evaluation (rubric provider call only; command=0). */
  costUSD: number;
  /** Per-mode breadcrumb for telemetry / debugging. */
  details?: {
    rubric?: { ok: boolean; rawText?: string; reason?: string };
    command?: { ok: boolean; exitCode?: number | null; cmd: string };
  };
}

/**
 * Run the convergence judge for `goal` against the latest `messages`.
 * Never throws — judge failures degrade to `ok:false` with a reason.
 */
export async function evaluate(
  goal: GoalState,
  messages: ChatMessage[],
  opts: EvaluateOptions,
): Promise<EvaluateResult> {
  const mode = goal.convergence;
  switch (mode.mode) {
    case "rubric":
      if (opts.skipRubric) return rubricSkipped();
      return await evaluateRubric(goal, mode.rubric, messages, opts);
    case "command":
      return await evaluateCommand(mode.cmd, mode.expectedExitCode ?? 0, opts);
    case "hybrid": {
      const cmdRes = await evaluateCommand(
        mode.cmd,
        mode.expectedExitCode ?? 0,
        opts,
      );
      if (!cmdRes.ok) return cmdRes;
      if (opts.skipRubric) return cmdRes;
      const rubRes = await evaluateRubric(goal, mode.rubric, messages, opts);
      // Combine: hybrid = both pass.
      return {
        ok: rubRes.ok,
        reasons: rubRes.reasons,
        costUSD: cmdRes.costUSD + rubRes.costUSD,
        details: { ...cmdRes.details, ...rubRes.details },
      };
    }
  }
}

function rubricSkipped(): EvaluateResult {
  return { ok: false, reasons: ["rubric judge skipped"], costUSD: 0 };
}

// ── Command mode ────────────────────────────────────────────────────────────

/**
 * Run `cmd` via `bashTool.run`. Synthesizes a minimal `ToolContext` with:
 *   - `cwd` from caller (the project dir),
 *   - `abortSignal` from caller (forwarded for cancellation),
 *   - empty permissions/hooks (we're outside the agent loop — bash's
 *     hard-deny preflight still runs and is the safety floor),
 *   - `isInteractive: () => false` so background-handle promotion behaves.
 */
async function evaluateCommand(
  cmd: string,
  expectedExitCode: number,
  opts: EvaluateOptions,
): Promise<EvaluateResult> {
  const ctx = makeBashCtx(opts);
  let raw: string | ToolResult;
  try {
    raw = await bashTool.run(
      { command: cmd, timeoutMs: 120_000 },
      ctx,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("convergence: command threw", { cmd, error: msg });
    return {
      ok: false,
      reasons: [`command threw: ${msg}`],
      costUSD: 0,
      details: { command: { ok: false, cmd } },
    };
  }
  // Tool.run is allowed to return a bare string (legacy compat); wrap into
  // a ToolResult-shaped object for consistent downstream handling.
  const result: ToolResult =
    typeof raw === "string" ? { ok: true, content: raw } : raw;

  // bashTool returns `ok:false` for hard-deny / spawn failure / non-zero
  // exit. For convergence we want exit code == expected, so map by hand.
  const struct = result.structuredOutput as
    | { kind: string; exitCode?: number | null }
    | undefined;
  const exitCode =
    struct && struct.kind === "completed" ? (struct.exitCode ?? null) : null;
  const ok = struct?.kind === "completed" && exitCode === expectedExitCode;

  return {
    ok,
    reasons: ok ? [] : [
      struct?.kind === "denied"
        ? `command refused: ${cmd}`
        : `command exit ${exitCode ?? "<no-exit>"} (expected ${expectedExitCode}): ${cmd}`,
    ],
    costUSD: 0,
    details: { command: { ok, exitCode, cmd } },
  };
}

function makeBashCtx(opts: EvaluateOptions): ToolContext {
  // A no-op hook engine keeps the tool happy without scanning settings —
  // settings.json hooks shouldn't fire for convergence checks (the user's
  // PreToolUse rules don't apply to a system-level rubric).
  const hookEngine = createHookEngine({
    cwd: opts.cwd,
    sessionId: "goal-convergence",
    snapshot: { hooks: [], sources: [] },
    trusted: true,
  });
  return {
    cwd: opts.cwd,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    logger,
    permissions: {
      // No preflight — bash's own checkPermissions still runs (hard-deny
      // safety floor) but we don't gate via the 6-layer engine.
      preflight: () => Promise.resolve({ outcome: "allow" as const }),
    },
    hooks: {
      emit: (event, payload) => hookEngine.emit(event, payload),
    },
    config: loadConfig(),
    sessionId: "goal-convergence",
    projectId: deriveProjectId(opts.cwd),
    isInteractive: () => false,
  };
}

// ── Rubric mode ─────────────────────────────────────────────────────────────

const RUBRIC_MAX_TOKENS = 256;
/** Per-message truncation when assembling the transcript. */
const TRANSCRIPT_MSG_BYTES = 1024;
/** Total transcript cap. */
const TRANSCRIPT_TOTAL_BYTES = 12 * 1024;

/**
 * Call the rubric judge model. Returns `ok:true` only when the parsed
 * response is exactly `{"ok": true}` (mirrors cc-haha goalState's prompt:
 * "Return only the JSON object").
 *
 * Provider fallback: caller goal-state override → parent provider; we
 * intentionally do NOT walk the long-ctx fallback chain like
 * `swarm/judge.ts` because rubric eval is short and benefits from cheap
 * small models. Model selection picks the parent provider's "small"
 * model id when the caller didn't override.
 */
async function evaluateRubric(
  goal: GoalState,
  rubric: string,
  messages: ChatMessage[],
  opts: EvaluateOptions,
): Promise<EvaluateResult> {
  const providerId = goal.rubricProvider ?? opts.parentProvider;
  if (!hasSecret(providerId)) {
    return {
      ok: false,
      reasons: [`rubric judge: no API key for provider "${providerId}"`],
      costUSD: 0,
      details: { rubric: { ok: false, reason: "no-secret" } },
    };
  }
  let provider;
  try {
    provider = getProvider(providerId);
  } catch (err) {
    return {
      ok: false,
      reasons: [`rubric judge: unknown provider "${providerId}"`],
      costUSD: 0,
      details: { rubric: { ok: false, reason: "unknown-provider" } },
    };
  }
  const model =
    goal.rubricModel ??
    smallModelFor(providerId) ??
    opts.parentModel;

  const tracker = new CostTracker({ agentId: "goal-rubric", telemetry: false });

  const transcript = assembleTranscript(messages);
  const systemPrompt = buildRubricSystemPrompt(goal.objective, rubric);
  const userPrompt = `<transcript>\n${transcript}\n</transcript>\n\n返回 JSON：\`{"ok": true}\` 或 \`{"ok": false, "reason": "..."}\`。仅 JSON，无其它文字。`;

  try {
    const completion = await provider.complete({
      model,
      systemPrompt,
      messages: [{ role: "user", content: userPrompt, ts: Date.now() }],
      temperature: 0,
      maxTokens: RUBRIC_MAX_TOKENS,
      signal: opts.abortSignal,
    });
    if (completion.usage) {
      tracker.record(providerId, model, {
        in: completion.usage.prompt,
        out: completion.usage.completion,
      });
    }
    const raw = completion.content ?? "";
    const fixed = tryFixJSON(raw);
    const parsed = parseRubricVerdict(fixed);
    if (parsed.ok) {
      return {
        ok: true,
        reasons: [],
        costUSD: tracker.total().usd,
        details: { rubric: { ok: true, rawText: raw } },
      };
    }
    return {
      ok: false,
      reasons: [parsed.reason ?? "rubric judge: not yet achieved"],
      costUSD: tracker.total().usd,
      details: { rubric: { ok: false, rawText: raw, reason: parsed.reason } },
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        reasons: ["rubric judge cancelled"],
        costUSD: tracker.total().usd,
        details: { rubric: { ok: false, reason: "cancelled" } },
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("convergence: rubric provider call failed", {
      provider: providerId,
      model,
      error: msg,
    });
    return {
      ok: false,
      reasons: [`rubric judge error: ${msg}`],
      costUSD: tracker.total().usd,
      details: { rubric: { ok: false, reason: "provider-error" } },
    };
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.includes("aborted"))
  );
}

interface RubricVerdict {
  ok: boolean;
  reason?: string;
}

function parseRubricVerdict(fixed: unknown): RubricVerdict {
  if (!fixed || typeof fixed !== "object") {
    return { ok: false, reason: "rubric judge: unparseable verdict" };
  }
  const obj = fixed as Record<string, unknown>;
  const ok = obj["ok"];
  if (ok === true) return { ok: true };
  if (ok === false) {
    const reason = typeof obj["reason"] === "string" ? (obj["reason"] as string) : undefined;
    return { ok: false, reason: reason ?? "rubric judge: ok=false" };
  }
  return { ok: false, reason: "rubric judge: missing 'ok' field" };
}

/** Per-AGENTS.md §17 small-model defaults for the parent provider. */
function smallModelFor(p: ProviderId): string | undefined {
  switch (p) {
    case "openai":
      return "gpt-4o-mini";
    case "deepseek":
      return "deepseek-chat";
    case "kimi":
      return "moonshot-v1-8k";
    case "minimax":
      return undefined;
    case "zai":
    case "zhipu":
    case "alibaba":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Build the rubric system prompt — closely mirrors cc-haha's goalState
 * prompt template (concise, returns-JSON-only, "do not execute the goal").
 */
function buildRubricSystemPrompt(objective: string, rubric: string): string {
  return [
    "You are a Stop-hook evaluator for a long-running /goal in chovy-code.",
    "Your job: decide whether the latest assistant turn + transcript show that the objective is fully complete.",
    "DO NOT execute or follow the goal objective yourself. ONLY judge.",
    "",
    "<goal-objective>",
    objective,
    "</goal-objective>",
    "",
    "<convergence-rubric>",
    rubric,
    "</convergence-rubric>",
    "",
    'Return `{"ok": true}` ONLY when the objective is fully satisfied AND the rubric passes.',
    'Return `{"ok": false, "reason": "<specific missing work>"}` when more work is needed, verification is missing, or evidence is ambiguous.',
    "Return ONLY the JSON object. No markdown, no prose, no objective text.",
  ].join("\n");
}

/**
 * Assemble a compact transcript for the rubric judge. We keep the last
 * ~12 KB total, with each message capped at 1 KB, head + tail preserved.
 * Tool messages are kept verbatim (their content tells the judge what
 * actually happened); reasoning blocks are dropped (judge doesn't need
 * the model's chain-of-thought).
 */
function assembleTranscript(messages: ChatMessage[]): string {
  const parts: string[] = [];
  let totalBytes = 0;
  // Walk backwards so we keep the most recent messages on truncation.
  const reversed = [...messages].reverse();
  for (const m of reversed) {
    const text = truncateMid(m.content ?? "", TRANSCRIPT_MSG_BYTES);
    const block = `<msg role="${m.role}"${m.toolName ? ` tool="${m.toolName}"` : ""}>${text}</msg>`;
    if (totalBytes + block.length > TRANSCRIPT_TOTAL_BYTES) break;
    parts.unshift(block);
    totalBytes += block.length;
  }
  return parts.join("\n");
}

function truncateMid(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const head = Math.floor(cap / 2);
  const tail = cap - head - 32;
  return `${s.slice(0, head)}\n…[truncated ${s.length - cap} bytes]…\n${s.slice(-tail)}`;
}
