/**
 * Explore agent — fast read-only codebase exploration (step-19).
 *
 * Inspired by cc-haha's `tools/AgentTool/built-in/exploreAgent.ts` (84
 * lines): strict read-only, parallel tool calls, small model, no MEMORY.md
 * injection. The role is the cheapest way to answer "what files does X
 * touch?" — it must NOT mutate state.
 *
 * Differences from cc-haha:
 *   - `omitClaudeMd` → `omitMemory` (chovy's Layer-2 equivalent; the 5-layer
 *     builder skips the dynamic memory/notes segments when this is true).
 *   - Model selection is a *preference* (`preferredModel`), not a hard
 *     override — the pool falls back to the parent's model when the
 *     provider doesn't carry the preferred SKU.
 */
import type { BuiltInAgentDefinition } from "../../types/index.js";
import type { SystemContext } from "../../prompts/index.js";

export const exploreAgent: BuiltInAgentDefinition = {
  role: "explorer",
  whenToUse:
    "Fast read-only exploration of a codebase. Use for locating code, " +
    "mapping call sites, or answering 'where is X?' without modifying anything.",
  description: "Read-only explorer (glob/grep/read); small model; no memory.",

  // Whitelist isn't set — we deny the mutating tools instead so new read-only
  // tools added later are automatically available to Explore.
  disallowedTools: [
    "agent",              // no nested sub-agents (prevent recursion)
    "file_edit",
    "file_write",
    "bash",               // bash can mutate; Explore is strictly read-only
    "ask_user_question",  // non-interactive by design
    "todo_write",         // no state changes, including the todo list
    "skill",              // skills may mutate; stay read-only
  ],

  // Small model preference; pool falls back to parent when the provider
  // doesn't carry this SKU. Kept as a hint, not a hard requirement, so
  // single-provider test setups still work.
  preferredModel: "gpt-4o-mini",

  omitMemory: true, // least-context: a read-only search doesn't need MEMORY.md

  budgetUSD: 0.10,
  timeoutMs: 60_000,
  maxRounds: 8,

  getSystemPrompt(ctx: SystemContext): string {
    return [
      "=== READ-ONLY MODE — 严禁文件修改 / 严禁状态变更 ===",
      "You are the **Explore** agent: a fast, read-only codebase scout.",
      "",
      "STRICTLY PROHIBITED (your tool whitelist already blocks these, but",
      "treat them as absolute rules regardless):",
      "- Creating or modifying any file (no write / edit / bash redirects).",
      "- Running any command that changes system state.",
      "- Spawning further sub-agents.",
      "",
      "DO:",
      "- Use `glob`, `grep`, `file_read`, `web_fetch`, `web_search` freely.",
      "- Make efficient use of tools: batch independent calls in one response",
      "  so they run in parallel. Prefer a few broad searches over many narrow",
      "  ones.",
      `- Working directory: ${ctx.cwd.cwd}.`,
      "",
      "RETURN a structured result with three sections:",
      "  files[]      — paths inspected, each with a one-line role note.",
      "  findings[]   — concrete observations tied to files/lines.",
      "  next_steps[] — suggested follow-ups for the parent agent (do NOT",
      "                 execute them yourself).",
      "",
      "Be concise. If the parent's question is already answered by a single",
      "search, say so and stop — do not pad with unrelated findings.",
    ].join("\n");
  },
};
