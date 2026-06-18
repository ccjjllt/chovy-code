/**
 * `agent` — spawn a sub-agent (step-11 stub → step-18 runtime).
 *
 * Per `docs/step-11-meta-tools.md §Agent(stub)`:
 *   - If `ctx.spawnSubAgent` is wired (step-18 sub-agent runtime), delegate
 *     to it and return its result.
 *   - Otherwise refuse with `INTERNAL` pointing at step-18, so the model
 *     learns the fan-out path isn't live yet instead of blocking.
 *
 * The schema matches the cc-haha AgentTool surface the model already knows:
 *   - `description` (≤80 chars) — what the sub-agent should do.
 *   - `prompt` — the full task prompt.
 *   - `subagent_type` — one of the four built-in roles (Explore/Plan/Verify/
 *     Critic; full roster in step-19).
 *   - `run_in_background` — detach so the parent can continue (SwarmR; the
 *     real scheduling lands in step-18/20).
 *
 * Why `subagent_type` is optional with only four values today? Step-19 locks
 * the full `BuiltInAgentDefinition` roster; until then we accept the four
 * roles `AGENTS.md §4` documents and let step-19 widen the enum without a
 * schema break (the model can still pass `undefined` for a plain "main"
 * fan-out).
 */

import { z } from "zod";

import { logger } from "../../logger/index.js";
import type {
  PermissionPreflight,
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
  "AgentTool: sub-agent runtime is not ready yet (step-18). " +
  "Until the SwarmR runtime lands, `agent` cannot spawn a real sub-agent. " +
  "Perform the fan-out work yourself in the current context, or surface the " +
  "intended delegation to the user.";

export const agentTool: Tool<typeof argsSchema> = {
  name: "agent",
  version: 2,
  family: "meta",
  isReadOnly: false, // a sub-agent can mutate the world
  canUseWithoutAsk: false, // spawning a sub-agent is a privileged, costly op

  desc: {
    lean:
      "Spawn a sub-agent (Explore/Plan/Verify/Critic) to handle a sub-task. " +
      "STUB until step-18 — delegates to ctx.spawnSubAgent when wired.",
    full:
      "Spawn a sub-agent to handle an independent sub-task, returning its " +
      "final transcript.\n\n" +
      "- `description` ≤80 chars; shown in the swarm panel (step-22).\n" +
      "- `prompt` is the full task brief.\n" +
      "- `subagent_type` picks a built-in role with a tool whitelist:\n" +
      "    • Explore — read-only (glob/grep/read/ls); small model.\n" +
      "    • Plan — read-only; outputs a Plan template; long-context model.\n" +
      "    • Verify — bash/read/grep/glob; outputs PASS/FAIL/PARTIAL.\n" +
      "    • Critic — read/grep/web; MUST find risks, no \"looks good\".\n" +
      "- `run_in_background: true` detaches (SwarmR; step-20).\n" +
      "- STATUS: until step-18 lands, this tool refuses with `INTERNAL` when " +
      "`ctx.spawnSubAgent` is absent. The schema is final.\n" +
      "- Each sub-agent gets its OWN AbortController (never the parent's) — " +
      "this is an AGENTS.md §9 hard rule the step-18 runtime enforces.",
    examples: [
      `agent({ description: "Find all tool registrations", prompt: "List every registerTool call and its namespace.", subagent_type: "Explore" })  // → INTERNAL (step-18)`,
      `agent({ description: "Verify the build", prompt: "Run bun run typecheck and report PASS/FAIL.", subagent_type: "Verify", run_in_background: true })  // → INTERNAL (step-18)`,
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
    // Spawning is privileged; once live, step-12 will gate on the sub-agent
    // role's tool whitelist. Today the stub executes nothing.
    return { outcome: "ask", reason: "spawn sub-agent (privileged)" };
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();

    // No runtime wired yet ⇒ refuse pointing at step-18.
    if (!ctx?.spawnSubAgent) {
      return {
        ok: false,
        content: NOT_READY_MSG,
        errorCode: "INTERNAL",
        structuredOutput: {
          kind: "stub",
          step: "step-18",
          subagent_type: args.subagent_type,
          background: args.run_in_background ?? false,
        },
        meta: { durMs: Date.now() - t0 },
      };
    }

    // step-18 wired the runtime — delegate. The exact request shape is owned
    // by step-18 (`SpawnRequest`); we pass the raw args through and let the
    // runtime validate. The result is opaque to us — we stringify it for the
    // model and forward structuredOutput.
    try {
      const result = await ctx.spawnSubAgent(args);
      const content =
        typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
      return {
        ok: true,
        content,
        structuredOutput: { kind: "spawned", result },
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
