# Step 19 — Built-in Sub-Agents（Explore / Plan / Verify / Critic）

**Phase**: E | **依赖**: 18 | **可并行**: ✅（与 step 20 并行） | **估时**: 5h

## 目标

定义 4 个内置子 agent，作为 `dispatch` / `agent` 工具的角色选项。
每个内置 agent 都有：固定 system prompt、工具白/黑名单、模型策略、可选 `omitMemory`。

## 产物

```
src/agent/builtin/
├── exploreAgent.ts          # 只读快搜
├── planAgent.ts             # 架构 / 计划
├── verifyAgent.ts           # 跑测试 / 验证结果
├── criticAgent.ts           # 给方案找漏洞（chovy-code 新增）
├── checkpointWriterAgent.ts # 给 SCW 用（步骤 26 详细）
└── index.ts
```

## 通用结构

```ts
export interface BuiltInAgentDefinition {
  role: AgentRole;
  whenToUse: string;          // 暴露给主 agent 的"what is this for"
  disallowedTools?: string[]; // 默认基础上再屏蔽
  allowedTools?: string[];    // 仅保留这些（与 disallowed 互斥）
  preferredProvider?: ProviderId;
  preferredModel?: string;    // e.g. 'haiku' / 'gpt-4o-mini' / 'glm-4-air'
  omitMemory?: boolean;       // 是否注入 MEMORY.md
  budgetUSD?: number;
  timeoutMs?: number;
  getSystemPrompt(ctx: SystemContext): string;
}
```

注册到 `AGENT_REGISTRY`，`spawnSubAgent({role:'explore'})` 时会读取定义。

## 4 个内置 agent

### Explore

- 用途："Fast read-only exploration of a codebase"；
- disallowed: `agent`, `dispatch`, `edit`, `write`, `bash`（接受 `read/glob/grep/ls`）；
- 模型：默认 `gpt-4o-mini` / `glm-4-air` / `haiku`，按 `provider` 推断；
- omitMemory: true（避免长 MEMORY.md 拖慢只读检索）；
- system prompt 关键段：
  - "READ-ONLY MODE — 严禁文件修改 / 严禁状态变更"
  - "尽可能并行调用工具"
  - "返回结构化结果：files[]、findings[]、next_steps[]"

### Plan

- 用途："Software architect making implementation plans"；
- disallowed: `edit`, `write`, `bash`；
- 模型：偏好长上下文（kimi / glm-4.5 / gemini-1.5-pro）；
- omitMemory: false（计划需要项目背景）；
- system prompt：
  - "你是软件架构师与计划专家"
  - "输出严格遵循模板：Goal / Approach / Steps / Critical Files for Implementation（3-5 个） / Risks"

### Verify

- 用途："Verify implementation results by running tests / typecheck"；
- allowed: `bash`, `read`, `grep`, `glob`；
- 模型：与父继承；
- system prompt：
  - "独立角色——不被 implementation 偏见影响"
  - "输出 PASS / FAIL / PARTIAL，附测试输出关键行"
  - "若 FAIL：列出最小复现步骤"

### Critic

> **chovy-code 新增**：用于对计划/代码做"找漏洞"式审阅，与 Verify 互补。

- 用途："Adversarial reviewer; finds risks others missed"；
- disallowed: `edit`, `write`, `bash`（只读 + WebSearch）；
- 模型：与父异构（如父用 GLM，则 Critic 用 Claude / DeepSeek，避免同模型偏见）；
- system prompt：
  - "你是吹毛求疵的审阅者；目标是找出方案 / 代码中的 *盲点* 与 *潜在风险*"
  - "输出格式：risks[]、unverified_assumptions[]、edge_cases[]、improvement_suggestions[]"
  - "不要给出 'Looks good'——必须找出问题，没有时输出 'No risks found in this scope, suggested deeper review on X'"

### CheckpointWriter（给 step-26 占位）

- 用途："Maintain structured session checkpoints"；
- allowed: `read`, `write`（仅 ~/.chovy/projects/x/checkpoints/）；
- 模型：小模型即可（gpt-4o-mini / glm-4-air）；
- 详见 step-26。

## 在 ATP / dispatch 中的使用

```
主 agent: 我要做大型重构。
  → dispatch([
      {role:'explore', prompt:'扫一遍代码库，找出所有受影响文件'},
      {role:'plan', prompt:'按 explore 结果出实施计划'},
      {role:'critic', prompt:'对该计划做反向审查，列出潜在风险'},
    ])
```

裁判模型聚合后给出 final_answer + risks + agreement。

## 验收标准

- `chovy "用 explore agent 找出所有 .ts 文件" --provider openai` → 看到子 agent 实际只读运行；
- explore 试图调 edit 工具时被自身权限白名单拒绝；
- critic 即使输入"完美方案"也能输出建议；
- checkpoint-writer 在 step-26 验收。

## 参考源

- `cc-haha/src/tools/AgentTool/built-in/exploreAgent.ts`、`planAgent.ts`、`verificationAgent.ts`

## 风险

- 角色 system prompt 漂移导致角色失效 → telemetry 监控每个 role 的工具使用分布。
