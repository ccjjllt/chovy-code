/**
 * Critic agent — adversarial reviewer (chovy-code addition, step-19).
 *
 * chovy-code-specific role (cc-haha has no direct equivalent). The Critic's
 * job is to find risks, unverified assumptions, and edge cases that Explore /
 * Plan / the implementation missed. It complements Verify: Verify checks
 * "does it work?", Critic checks "what could go wrong that we haven't
 * tested?".
 *
 * Design choices:
 *   - Read-only + web (no bash, no edits) — Critic reviews, it doesn't run.
 *   - `preferredModel` is intentionally `undefined` but the prompt notes the
 *     *intent* of model heterogeneity (if the parent used GLM, the orchestrator
 *     SHOULD spawn Critic on a different family to avoid same-model blind
 *     spots). The pool doesn't force this; SwarmR (step-20) / the caller can
 *     pass an explicit `model` override on the SpawnInput.
 *   - The prompt forbids "Looks good" — a Critic that rubber-stamps is worse
 *     than no Critic, because it creates false confidence.
 */
import type { BuiltInAgentDefinition } from "../../types/index.js";
import type { SystemContext } from "../../prompts/index.js";

export const criticAgent: BuiltInAgentDefinition = {
  role: "critic",
  whenToUse:
    "Adversarial reviewer that finds risks others missed. Use after a plan or " +
    "implementation exists — Critic reviews it for blind spots, unverified " +
    "assumptions, and edge cases. Complements Verify (which runs tests).",
  description: "Adversarial reviewer (read/grep/web); MUST find risks, no 'looks good'.",

  disallowedTools: [
    "file_edit",
    "file_write",
    "bash", // Critic reviews, doesn't execute — execution is Verify's job
    "agent",
  ],

  // Intentionally undefined: the orchestrator should ideally spawn Critic on a
  // *different* model family than the parent (e.g. parent=GLM → Critic=Claude)
  // to avoid shared blind spots. The pool inherits the parent model unless
  // the caller passes an explicit `model` on the SpawnInput. SwarmR (step-20)
  // will wire this heterogeneity automatically.
  preferredModel: undefined,

  omitMemory: false,

  budgetUSD: 0.12,
  timeoutMs: 90_000,
  maxRounds: 8,

  getSystemPrompt(ctx: SystemContext): string {
    return [
      "你是 **Critic** agent — 吹毛求疵的审阅者。",
      "",
      "你的目标是找出方案 / 代码中的 *盲点* 与 *潜在风险*，而不是确认它「看起来",
      "没问题」。一个说「Looks good」的 Critic 比没有 Critic 更糟——它制造虚假",
      "安全感。",
      "",
      "你只能用：`file_read`、`grep`、`glob`、`web_fetch`、`web_search`（只读 +",
      "查证）。不能 edit/write/bash。",
      `- Working directory: ${ctx.cwd.cwd}。`,
      "",
      "DO:",
      "- 主动读相关代码 / 配置 / 文档，不要只凭摘要下结论。",
      "- 用 `web_search` 查证可疑假设（如「某 API 一定支持 X」）。",
      "- 关注：并发 / 竞态、错误处理缺失、资源泄漏、安全（注入/路径穿越/越权）、",
      "  跨平台、向后兼容、性能边界、未测试的分支。",
      "",
      "输出**严格**遵循以下格式（四段，缺一不可）：",
      "",
      "## risks[]",
      "- <每个风险：描述 + 触发条件 + 影响 + 建议缓解>",
      "",
      "## unverified_assumptions[]",
      "- <方案隐含但未验证的假设；标注「待 Verify 确认」或「待人工确认」>",
      "",
      "## edge_cases[]",
      "- <边界场景：空输入、超大输入、并发、失败重试、网络中断等>",
      "",
      "## improvement_suggestions[]",
      "- <具体可执行的改进建议；不要泛泛而谈>",
      "",
      "若在本次审查范围内确实未发现风险，**不要**输出「Looks good」。改为输出：",
      "「No risks found in this scope, suggested deeper review on <X>」——其中 <X>",
      "是你认为仍需深入审查的具体方向（不是空话）。",
    ].join("\n");
  },
};
