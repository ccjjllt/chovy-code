/**
 * Verify agent — independent verification by running tests / typecheck
 * (step-19).
 *
 * Modeled on cc-haha's `verificationAgent.ts`. The key design property is
 * **independence**: Verify must not be biased by the implementation agent's
 * framing. It runs the actual test suite / typecheck / build and reports
 * PASS / FAIL / PARTIAL with the minimal repro on failure.
 *
 * Unlike Explore/Plan, Verify gets `bash` — it has to *run* things. The
 * whitelist is tight (bash + read + grep + glob) so it can't edit code to
 * "make tests pass" (that would defeat the purpose of independent
 * verification).
 */
import type { BuiltInAgentDefinition } from "../../types/index.js";
import type { SystemContext } from "../../prompts/index.js";

export const verifyAgent: BuiltInAgentDefinition = {
  role: "verifier",
  whenToUse:
    "Verify implementation results by running tests / typecheck / build. Use " +
    "after code changes to independently confirm PASS/FAIL — runs commands but " +
    "does not edit code.",
  description: "Independent verifier (bash/read/grep/glob); outputs PASS/FAIL/PARTIAL.",

  // Whitelist (not blacklist): Verify gets exactly these tools. This is
  // stricter than a denylist because new mutating tools added later must NOT
  // silently become available to Verify.
  allowedTools: ["bash", "file_read", "grep", "glob"],

  // Inherit parent's model — verification doesn't need a different model,
  // and using the same model the implementation used keeps cost predictable.
  preferredModel: undefined,

  omitMemory: false, // may need to recall the project's test commands

  budgetUSD: 0.15,
  timeoutMs: 120_000,
  maxRounds: 10,

  getSystemPrompt(ctx: SystemContext): string {
    return [
      "你是 **Verify** agent — 独立验证者。",
      "",
      "独立角色原则：你不被 implementation agent 的偏见影响。不要相信它说的",
      "「已修复」「测试通过」——你自己跑命令验证。如果 implementation 声称",
      "完成但你无法复现，记为 PARTIAL 并说明差异。",
      "",
      "你只能用：`bash`（跑测试/typecheck/build）、`file_read`、`grep`、`glob`。",
      "不能 edit/write — 即使测试失败也不能改代码「让它过」，那是",
      "implementation 的活。你的职责是报告事实。",
      `- Working directory: ${ctx.cwd.cwd}。`,
      "",
      "DO:",
      "- 先用 `glob`/`file_read` 确认项目用的测试框架（package.json scripts、",
      "  *.test.ts、Makefile 等），再跑对应命令。",
      "- 用绝对路径或 `cd`-free 命令；避免副作用。",
      "- 跑真实命令，不要模拟输出。",
      "",
      "输出**严格**遵循以下格式：",
      "",
      "## Result: PASS | FAIL | PARTIAL",
      "",
      "## Evidence",
      "<测试输出的关键行（≤20 行）；包含命令本身 + 退出码>",
      "",
      "## Notes",
      "<若 FAIL/PARTIAL：列出最小复现步骤；若 PASS：一句话说明覆盖了什么>",
      "",
      "判定规则：",
      "- PASS = 所有相关命令退出码 0。",
      "- FAIL = 有命令退出码非 0。",
      "- PARTIAL = 部分通过、或无法验证（缺依赖、超时、命令不存在）。",
    ].join("\n");
  },
};
