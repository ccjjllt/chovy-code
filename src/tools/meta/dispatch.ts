/**
 * `dispatch` — SwarmR parallel fan-out (step-20).
 *
 * The dispatch tool lets the main agent fan N prompts (≤ 100) out to N
 * sub-agents in a single call, each independently configurable (role /
 * provider / model / tools / budget / timeout). Results come back in
 * original array order; an optional judge (step-21) aggregates them into a
 * structured verdict.
 *
 * Wiring: the tool delegates to `ctx.dispatchSwarm`, a handle the
 * QueryEngine injects for the top-level `main` role (bound to the live
 * parent runtime context, mirroring `ctx.spawnSubAgent`). Sub-agent runs and
 * any context that hasn't wired SwarmR see `ctx.dispatchSwarm === undefined`
 * and the tool refuses with `INTERNAL` — the same stance the `agent` tool
 * takes before step-18 wiring lands.
 *
 * The tool is a thin adapter: it parses args, calls `dispatchSwarm`, and
 * shapes the result for the model. All orchestration (concurrency limit,
 * global budget, cancel cascade, judge hook) lives in `src/swarm/router.ts`.
 *
 * Permission: dispatching is privileged + costly, so `checkPermissions`
 * returns `ask` (mirroring the `agent` tool). The permission engine still
 * gates each spawned child's tool calls independently inside its own run.
 */

import { z } from "zod";

import { logger } from "../../logger/index.js";
import type {
  PermissionPreflight,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types/index.js";
import type {
  DispatchInput,
  DispatchOutput,
  DispatchPrompt,
  DispatchRole,
  JudgeSchemaName,
} from "../../swarm/router.js";

// ── wire schema ────────────────────────────────────────────────────────────

const PROMPT_MAX = 100;

const providerEnum = z.enum([
  "openai",
  "deepseek",
  "zai",
  "zhipu",
  "kimi",
  "minimax",
  "alibaba",
]);

const promptSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Stable id for the result slot. Defaults to a positional label (p0, p1, …).",
    ),
  prompt: z.string().min(1).describe("Full task brief handed to the sub-agent."),
  role: z
    .enum(["explore", "plan", "verify", "critic", "custom"])
    .optional()
    .describe(
      "Built-in role. `explore` (read-only search), `plan` (architect, no code), " +
        "`verify` (PASS/FAIL check), `critic` (must find risks), `custom` (escape hatch).",
    ),
  provider: providerEnum
    .optional()
    .describe("Per-prompt provider override; falls back to the parent's."),
  model: z
    .string()
    .optional()
    .describe("Per-prompt model override; falls back to the provider default."),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool whitelist by name (intersected with the runtime pool)."),
  disallowedTools: z
    .array(z.string())
    .optional()
    .describe("Tool blacklist by name."),
  maxTokens: z
    .number()
    .optional()
    .describe(
      "Per-prompt output token cap. (Reserved on the wire; the pool forwards " +
        "maxRounds today — see router TODO.)",
    ),
  timeoutMs: z.number().optional().describe("Per-prompt wall-clock cap in ms."),
  budgetUSD: z
    .number()
    .optional()
    .describe("Per-prompt USD cap; default 0.20 (step-18 default)."),
});

const judgeSchema = z
  .object({
    enabled: z.boolean().default(true),
    schema: z
      .enum(["consensus", "compare", "rank", "custom"])
      .default("consensus"),
    customSchema: z.unknown().optional(),
    provider: providerEnum.optional(),
    model: z.string().optional(),
  })
  .optional();

const argsSchema = z.object({
  prompts: z
    .array(promptSchema)
    .min(1)
    .max(PROMPT_MAX)
    .describe("Sub-agent prompts. Results return in this order."),
  judge: judgeSchema.describe(
    "Optional judge aggregator (step-21). When enabled, a referee model " +
      "constrains the N results to a zod schema (consensus/compare/rank/custom) " +
      "and returns a structured `JudgedAggregate` in `judgement`.",
  ),
  parallelism: z
    .number()
    .min(1)
    .max(PROMPT_MAX)
    .default(8)
    .describe("Max concurrent in-flight spawns."),
  shareSession: z
    .boolean()
    .default(true)
    .describe("Inject the parent session snapshot into each child? Default true."),
  budgetUSD: z
    .number()
    .optional()
    .describe("Dispatch-wide USD cap. Trips → cancelAll + stopReason='budgetExceeded'."),
});

type Args = z.infer<typeof argsSchema>;

const NOT_READY_MSG =
  "dispatch: SwarmR is not ready in this context (ctx.dispatchSwarm is missing). " +
  "Only the top-level main agent can dispatch; sub-agents cannot fan out " +
  "until a future step opts them in. Perform the task in the current context " +
  "or surface the intended delegation to the user.";

export const dispatchTool: Tool<typeof argsSchema> = {
  name: "dispatch",
  version: 2,
  family: "meta",
  isReadOnly: false, // spawned sub-agents can mutate the world
  canUseWithoutAsk: false, // fan-out is privileged + costly

  desc: {
    lean:
      "Fan out N prompts (≤100) to N sub-agents in parallel, each with its own " +
      "role/provider/model/budget. Returns results in original order (+ optional judge).",
    full:
      "SwarmR parallel dispatch — the main agent's fan-out primitive.\n\n" +
      "- `prompts` (1..100): each independently configurable:\n" +
      "    • role: explore / plan / verify / critic / custom\n" +
      "    • provider + model: per-prompt heterogenous routing (e.g. glm-4-air " +
      "for explore, claude-sonnet-4 for critic)\n" +
      "    • tools / disallowedTools / timeoutMs / budgetUSD\n" +
      "- `parallelism` (default 8): max concurrent in-flight spawns.\n" +
      "- `shareSession` (default true): inject the parent session snapshot.\n" +
      "- `budgetUSD`: dispatch-wide cap; on breach the router cancels every " +
      "still-running child and returns stopReason='budgetExceeded'.\n" +
      "- `judge`: optional step-21 aggregator (consensus/compare/rank/custom). " +
      "A referee model runs after the fan-out, constrains the results to the " +
      "chosen zod schema, and returns a `JudgedAggregate` (ok/data/rawText/" +
      "costUSD/modelUsed). Judge failure is non-fatal — `judgement.ok=false` " +
      "and the raw results still return.\n\n" +
      "Failure propagation: a single child failing does NOT abort siblings " +
      "(its result slot is ok=false). Only the global budget or a dispatch " +
      "abort cancels the whole fan-out.\n\n" +
      "Returns: spawnedIds[], results[] (id/ok/content/structuredOutput/" +
      "costUSD/status/reason/provider/model), judgement?, totalCostUSD, stopReason.",
    examples: [
      `dispatch({ prompts: [
  { role: "explore", prompt: "Audit src/tools registrations", provider: "glm", model: "glm-4-air" },
  { role: "critic",  prompt: "Find risks in the ATP allocator", provider: "anthropic", model: "claude-sonnet-4" },
], parallelism: 2 })`,
    ],
  },

  fullTriggers: [
    /\b(dispatch|swarm|fan\s*out|parallel\s+(agents?|prompts?|dispatch))\b/i,
    /(并行|分发|派发|群智|子\s*agent\s*并行)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    const n = args?.prompts?.length ?? 0;
    return n > 0 ? `dispatch: ${n} prompt${n === 1 ? "" : "s"}` : "dispatch";
  },

  checkPermissions(): PermissionPreflight {
    // Fan-out is privileged + costly. The permission engine still gates each
    // spawned child's tool calls inside its own run; this preflight is the
    // gate on the dispatch itself.
    return { outcome: "ask", reason: "swarm dispatch (privileged, costly)" };
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();

    if (!ctx?.dispatchSwarm) {
      return {
        ok: false,
        content: NOT_READY_MSG,
        errorCode: "INTERNAL",
        structuredOutput: {
          kind: "no-runtime",
          prompts: args.prompts.length,
        },
        meta: { durMs: Date.now() - t0 },
      };
    }

    const input: DispatchInput = {
      prompts: args.prompts.map(toDispatchPrompt),
      judge: args.judge
        ? {
            enabled: args.judge.enabled,
            schema: args.judge.schema as JudgeSchemaName,
            customSchema: args.judge.customSchema,
            provider: args.judge.provider,
            model: args.judge.model,
          }
        : undefined,
      parallelism: args.parallelism,
      shareSession: args.shareSession,
      budgetUSD: args.budgetUSD,
      // The engine-injected handle forwards the parent abort signal; the
      // tool itself doesn't touch signals.
      abortSignal: undefined,
    };

    try {
      const out: DispatchOutput = await ctx.dispatchSwarm(input);
      return {
        ok: out.stopReason !== "cancelled" || out.results.some((r) => r.ok),
        content: summarizeDispatch(out),
        structuredOutput: out,
        meta: { durMs: Date.now() - t0 },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatch: swarmDispatch threw", { error: msg });
      return {
        ok: false,
        content: `dispatch: fan-out failed — ${msg}`,
        errorCode: "INTERNAL",
        structuredOutput: {
          kind: "error",
          error: msg,
          prompts: args.prompts.length,
        },
        meta: { durMs: Date.now() - t0 },
      };
    }
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function toDispatchPrompt(p: Args["prompts"][number]): DispatchPrompt {
  return {
    id: p.id,
    prompt: p.prompt,
    role: p.role as DispatchRole | undefined,
    provider: p.provider,
    model: p.model,
    tools: p.tools,
    disallowedTools: p.disallowedTools,
    maxTokens: p.maxTokens,
    timeoutMs: p.timeoutMs,
    budgetUSD: p.budgetUSD,
  };
}

/**
 * Render a dispatch result as a compact, model-facing summary. The full
 * `DispatchOutput` rides `structuredOutput` for programmatic consumers; this
 * string is what the model reads to decide its next step.
 */
function summarizeDispatch(out: DispatchOutput): string {
  const lines: string[] = [];
  lines.push(
    `SwarmR dispatch: ${out.results.length} prompt(s), ` +
      `stopReason=${out.stopReason}, totalCost=$${out.totalCostUSD.toFixed(4)}`,
  );
  for (const r of out.results) {
    const tag = r.ok ? "OK" : r.status.toUpperCase();
    const cost = `$${r.costUSD.toFixed(4)}`;
    const prov = [r.provider, r.model].filter(Boolean).join("/");
    const body = r.content
      ? r.content.length > 400
        ? r.content.slice(0, 400) + "…"
        : r.content
      : "(no content)";
    lines.push(
      `- [${r.id}] ${tag} ${prov} ${cost}` +
        (r.reason ? ` (${r.reason})` : "") +
        `: ${body}`,
    );
  }
  if (out.judgement !== undefined) {
    const j = out.judgement;
    if (j.ok) {
      lines.push(
        `judge: OK ${j.schemaName} ${j.providerUsed}/${j.modelUsed} ` +
          `$${j.costUSD.toFixed(4)} (attempts=${j.attempts})`,
      );
      lines.push(`judge.data: ${JSON.stringify(j.data)}`);
    } else {
      lines.push(
        `judge: FAIL ${j.schemaName} reason=${j.reason ?? "?"} ` +
          `${j.providerUsed}/${j.modelUsed} $${j.costUSD.toFixed(4)}`,
      );
    }
  } else {
    lines.push("judge: (disabled)");
  }
  return lines.join("\n");
}
