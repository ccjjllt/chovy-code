/**
 * `agent` — spawn a sub-agent.
 *
 * Until step-18 the tool was a stub returning `INTERNAL` whenever invoked.
 * step-18 wires the runtime: when `ctx.spawnSubAgent` is present (which
 * it is for top-level `main` runs), the tool maps the cc-haha-style
 * `subagent_type` enum to chovy's `AgentRole`, dispatches via the pool,
 * and returns a structured handle snapshot. For `run_in_background: true`
 * the tool resolves with the queued/running handle so the parent can keep
 * working; for foreground spawns it waits for terminal status.
 *
 * The `subagent_type` field stays optional — if absent, the runtime
 * spawns a plain `main`-shaped sub-agent (rare in practice but useful for
 * one-off fan-outs). step-19 ships the four built-in role definitions
 * (Explore/Plan/Verify/Critic): the pool auto-applies each role's tool
 * whitelist/blacklist, model preference, omitMemory, budget/timeout, and
 * Layer-2 system prompt. The caller does NOT pass tools/provider/model
 * here — the role definition owns those (least-privilege; the caller can
 * only tighten via SpawnInput, never widen). `checkpoint-writer` is not
 * reachable from this tool (step-26 / SCW spawns it directly).
 */

import { z } from "zod";

import { logger } from "../../logger/index.js";
import type {
  AgentRole,
  PermissionPreflight,
  SpawnInput,
  SubAgentHandle,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types/index.js";

const DESCRIPTION_MAX = 80;

const argsSchema = z.object({
  description: z
    .string()
    .max(DESCRIPTION_MAX)
    .describe("Short (≤80 char) summary of what the sub-agent should do."),
  prompt: z
    .string()
    .min(1)
    .describe("The full task prompt handed to the sub-agent."),
  subagent_type: z
    .enum(["Explore", "Plan", "Verify", "Critic"])
    .optional()
    .describe(
      "Built-in role: Explore (read-only search), Plan (architect, no code), " +
        "Verify (independent PASS/FAIL check), Critic (must find risks). " +
        "Omit for a plain main-style fan-out.",
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe("If true, detach so the parent continues (SwarmR scheduling)."),
});

type Args = z.infer<typeof argsSchema>;

const NOT_READY_MSG =
  "AgentTool: sub-agent runtime is not ready in this context " +
  "(ctx.spawnSubAgent is missing). Sub-agents themselves cannot fan out " +
  "until SwarmR (step-20) lands; perform the task in the current context " +
  "or surface the intended delegation to the user.";

/** Map cc-haha-style enum → chovy AgentRole. step-19 fills the per-role
 *  prompts/tool whitelists/model preferences via the built-in registry; the
 *  pool applies them automatically at spawn time. `checkpoint-writer` is
 *  intentionally not in the enum — step-26 / SCW spawns it directly. */
function mapRole(t: Args["subagent_type"]): AgentRole {
  switch (t) {
    case "Explore":
      return "explorer";
    case "Plan":
      return "planner";
    case "Verify":
      return "verifier";
    case "Critic":
      return "critic";
    default:
      return "main";
  }
}

export const agentTool: Tool<typeof argsSchema> = {
  name: "agent",
  version: 2,
  family: "meta",
  isReadOnly: false, // a sub-agent can mutate the world
  canUseWithoutAsk: false, // spawning a sub-agent is a privileged, costly op

  desc: {
    lean:
      "Spawn a sub-agent (Explore/Plan/Verify/Critic) to handle a sub-task. " +
      "Returns a handle snapshot with status / cost / final content.",
    full:
      "Spawn a sub-agent to handle an independent sub-task, returning its " +
      "final transcript snapshot.\n\n" +
      "- `description` ≤80 chars; shown in the swarm panel (step-22).\n" +
      "- `prompt` is the full task brief.\n" +
      "- `subagent_type` picks a built-in role (step-19 ships the prompts + " +
      "tool lists):\n" +
      "    • Explore — read-only (glob/grep/read/ls); small model; no memory. " +
      "Fast codebase scout; returns files[]/findings[]/next_steps[].\n" +
      "    • Plan — read-only; outputs a Plan template " +
      "(Goal/Approach/Steps/Critical Files/Risks); long-context model.\n" +
      "    • Verify — bash/read/grep/glob only; independent PASS/FAIL/PARTIAL " +
      "with test output. Not biased by the implementation.\n" +
      "    • Critic — read/grep/web; MUST find risks, no \"looks good\". " +
      "Adversarial reviewer; complements Verify.\n" +
      "- The role definition owns its tool whitelist/blacklist, model " +
      "preference, omitMemory, budget/timeout — you don't (and can't) pass " +
      "those here (least-privilege).\n" +
      "- `run_in_background: true` detaches: the tool resolves immediately " +
      "with a `running` handle so the parent can keep working (SwarmR; step-20 " +
      "adds parallel dispatch).\n" +
      "- Each sub-agent gets its OWN AbortController (never the parent's) — " +
      "AGENTS.md §9 hard rule, enforced by the pool.\n" +
      "- Defaults (role may override): maxRounds=12, budgetUSD=$0.20, " +
      "timeoutMs=120s.",
    examples: [
      `agent({ description: "Find all tool registrations", prompt: "List every registerTool call and its namespace.", subagent_type: "Explore" })`,
      `agent({ description: "Verify the build", prompt: "Run bun run typecheck and report PASS/FAIL.", subagent_type: "Verify", run_in_background: true })`,
    ],
  },

  fullTriggers: [
    /\b(sub-?agent|spawn|fan\s*out|delegate|explore\s+agent|parallel\s+(tool|search))\b/i,
    /(子\s*agent|派生|分发|并行|代理)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    const role = args?.subagent_type ?? "agent";
    const d = args?.description ?? "";
    return d ? `${role}: ${d}` : role;
  },

  checkPermissions(): PermissionPreflight {
    // Spawning is privileged; step-12's engine gates on the sub-agent
    // role's tool whitelist (step-19 ships the rules). Default to `ask`
    // so non-trusted modes route through the user.
    return { outcome: "ask", reason: "spawn sub-agent (privileged)" };
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();

    if (!ctx?.spawnSubAgent) {
      // Either the runtime hasn't been initialized (tests, sub-agent
      // recursion until step-20) or the engine deliberately did not wire
      // it. Refuse with a structured error so the model adapts.
      return {
        ok: false,
        content: NOT_READY_MSG,
        errorCode: "INTERNAL",
        structuredOutput: {
          kind: "no-runtime",
          subagent_type: args.subagent_type,
          background: args.run_in_background ?? false,
        },
        meta: { durMs: Date.now() - t0 },
      };
    }

    const role = mapRole(args.subagent_type);
    const background = args.run_in_background ?? false;
    const spawnInput: SpawnInput = {
      role,
      prompt: args.prompt,
      background,
    };

    try {
      const handle: SubAgentHandle = await ctx.spawnSubAgent(spawnInput);
      const snapshot = summarizeHandle(handle);
      const ok = !background ? handle.status === "done" : true;
      const content = !background
        ? handle.result?.content || `(sub-agent ${handle.status})`
        : `Sub-agent ${handle.id} (${role}) running in background.`;
      return {
        ok,
        content,
        structuredOutput: snapshot,
        meta: { durMs: Date.now() - t0 },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("agent: spawnSubAgent threw", { error: msg });
      return {
        ok: false,
        content: `agent: sub-agent spawn failed — ${msg}`,
        errorCode: "INTERNAL",
        structuredOutput: { kind: "error", error: msg },
        meta: { durMs: Date.now() - t0 },
      };
    }
  },
};

/** Read-only projection of a handle for `structuredOutput`. */
function summarizeHandle(h: SubAgentHandle): Record<string, unknown> {
  return {
    kind: "handle",
    id: h.id,
    parentId: h.parentId,
    role: h.role,
    status: h.status,
    phase: h.phase,
    background: h.background,
    spawnedAt: h.spawnedAt,
    finishedAt: h.finishedAt,
    costUSD: h.costUSD,
    tokensIn: h.tokensIn,
    tokensOut: h.tokensOut,
    provider: h.provider,
    model: h.model,
    result: h.result
      ? {
          ok: h.result.ok,
          content: h.result.content,
          reason: h.result.reason,
          structuredOutput: h.result.structuredOutput,
        }
      : undefined,
  };
}
