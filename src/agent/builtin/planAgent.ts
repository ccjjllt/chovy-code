/**
 * Plan agent — software architect making implementation plans (step-19).
 *
 * Read-only (no edits, no bash) but DOES see memory — planning needs project
 * context (decisions, conventions, prior progress). Outputs a strict Plan
 * template so downstream agents (Verify, Critic) can consume it
 * programmatically. Modeled on cc-haha's `planAgent.ts` (93 lines).
 *
 * Unlike Explore, Plan keeps `omitMemory: false`: an architect with no
 * project background produces generic plans. The trade-off is a few hundred
 * extra tokens of MEMORY.md — worth it for plan quality.
 */
import type { BuiltInAgentDefinition } from "../../types/index.js";
import type { SystemContext } from "../../prompts/index.js";

export const planAgent: BuiltInAgentDefinition = {
  role: "planner",
  whenToUse:
    "Software architect making implementation plans. Use when the task needs " +
    "a structured approach (Goal/Approach/Steps/Critical Files/Risks) before " +
    "any code is written. Read-only — does not edit or run commands.",
  description: "Architect (read-only); outputs Plan template; long-context model.",

  disallowedTools: [
    "file_edit",
    "file_write",
    "bash",
    "agent", // planning is terminal; no nested fan-out
  ],

  // No hard model override — Plan benefits from a long-context model, but the
  // pool inherits the parent's model rather than forcing one, so the user's
  // chosen provider (kimi/glm/gemini all have ≥128k context) is respected.
  preferredModel: undefined,

  omitMemory: false, // plans need project background

  budgetUSD: 0.15,
  timeoutMs: 90_000,
  maxRounds: 10,

  getSystemPrompt(ctx: SystemContext): string {
    return [
      "你是软件架构师与计划专家（**Plan** agent）。",
      "",
      "你的职责：在写任何代码之前，产出一个可执行的实施计划。你只读不写",
      "（不能 edit / write / bash）；用 `glob`/`grep`/`file_read`/`web_*` 收集",
      "足够上下文后输出计划。",
      "",
      "DO:",
      "- 先调研：至少读 2-3 个关键文件再下结论，不要凭文件名猜测。",
      `- Working directory: ${ctx.cwd.cwd}。`,
      "- 若计划依赖未验证的假设，明确标注（Critic 会审查这些）。",
      "",
      "输出**严格**遵循以下模板（不要增删段落标题，不要加前后缀）：",
      "",
      "## Goal",
      "<一句话目标，可验证>",
      "",
      "## Approach",
      "<整体思路，2-4 句；说明为什么选这个方向而非其它>",
      "",
      "## Steps",
      "1. <步骤，每步可独立验收>",
      "2. ...",
      "",
      "## Critical Files for Implementation",
      "- `<path>` — <为何关键，改动范围>",
      "（列 3-5 个；超过 5 个说明范围过大，需拆分）",
      "",
      "## Risks",
      "- <风险 + 缓解；若无明显风险写 'No major risks identified'>",
      "",
      "保持简洁。计划是给主 agent 和 Verify/Critic 消费的，不是给人读的散文。",
    ].join("\n");
  },
};
