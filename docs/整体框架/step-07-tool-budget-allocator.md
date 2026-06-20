# Step 07 — Tool Budget Allocator（ATP 创新落地）

**Phase**: B | **依赖**: 06 | **可并行**: ❌ | **估时**: 4h

## 目标

实现 **ATP — Adaptive Tool Protocol** 的运行时核心：
> 每次构建 system prompt 时动态决定每个工具用 lean 还是 full 描述，以平衡命中率与上下文成本。

## 产物

```
src/tools/budget.ts          # 主算法
src/tools/relevance.ts       # 相关度打分
src/tools/__tests__/         # 单测（可在 step-30 补全）
```

## 算法设计

### 1. 输入

```ts
interface BudgetInput {
  tools: Tool[];                         // 已注册可用工具
  budgetTokens: number;                  // 来自 ContextBudget.tools
  recentMessages: ChatMessage[];         // 最近 8 条
  lastCalledTools: string[];             // 上一轮 tool_use 的 name 列表
  agentRole: AgentRole;                  // explorer / planner ...
  modelTokenizer?: (s: string) => number;// 估算用，可缺省（4 chars / token）
}
```

### 2. 步骤

```
Step 1：默认全部 lean，统计 baseline tokens。
Step 2：计算可升级预算 upgradeBudget = budgetTokens - baseline。
        若 < 0 → 触发 lean-only 模式（甚至要进一步压缩 lean）。
Step 3：为每个工具计算 score：
        score = 0.6*keywordHit + 0.25*lastUseRecency + 0.15*roleAffinity
        - keywordHit: fullTriggers 命中（regex）+ message 中 verbs 命中（read/edit/run/search…）
        - lastUseRecency: 上一轮使用过 → 0.8；上上轮 → 0.4；否则 0
        - roleAffinity: explorer→Glob/Grep/Read 加权；planner→TodoWrite 加权；…
Step 4：按 score 降序遍历；
        - 若 family 已升过 full，跳过（互斥）；
        - 若 (toolFullTokens - toolLeanTokens) > upgradeBudget，跳过；
        - 否则升级，扣 upgradeBudget。
Step 5：返回 DescribedTool[]，并打 telemetry 'tools.described'。
```

### 3. 角色亲和度表

```ts
const ROLE_AFFINITY: Record<AgentRole, Record<string, number>> = {
  explorer: { glob: 0.9, grep: 0.9, read: 0.8, bash: 0.2 },
  planner:  { todo_write: 0.9, ask_user: 0.6, glob: 0.4 },
  verifier: { bash: 0.9, read: 0.7 },
  critic:   { read: 0.6 },
  main:     { /* 不偏置 */ },
  // ...
};
```

### 4. 边界保护

- 如果 `tools.length > 30`，强制只升 top-K（K = floor(budget / avg_full_tokens)）。
- 如果 lean 描述本身超出 budgetTokens（罕见），按 score 倒序裁工具（产生 `ChovyError('TOOL_BUDGET')` warning，仍返回部分）。
- 如果 `budgetTokens <= 0`，按 0 预算处理：裁掉所有正 token 成本的 lean 描述，返回空或仅保留零成本描述，且记录 `TOOL_BUDGET` warning。
- ATP 不影响 schema：schema 永远完整注入。

## 与 QueryEngine 的集成点

```ts
// queryEngine.ts 调用
const described = describeTools({
  tools: registeredTools,
  budgetTokens: contextBudget.tools,
  recentMessages: messages.slice(-8),
  lastCalledTools: extractLastTools(messages),
  agentRole: ctx.agentRole,
});
const toolsForProvider = described.map(d => ({ name: d.name, description: d.description, schema: d.schemaJson }));
```

## 验收标准

- 在 25 个工具、budget=2k 时：
  - lean baseline ≈ 1.6k；
  - 用户输入 "搜下所有 .ts 文件" → Glob 升 full、其他保持 lean；
  - Edit/Write 同 family 互斥（不会同时 full）。
- telemetry 中可查到每次 dispatch 的 lean/full 比例。
- 单元测试覆盖：预算不足、空消息、role 亲和度。

## 参考源

- 无直接对应（这是 chovy-code 的差异化创新）；可借鉴 cc-haha tool description 静态结构作输入。

## 风险

- 评分模型过拟合 → 用简单加权 + telemetry 持续观测；不引入小模型评分（避免额外 API 调用）。
- 工具作者的 `fullTriggers` 若使用带 `g` / `y` 标志的 RegExp，`test()` 会受 `lastIndex` 影响 → 匹配前必须复位 `lastIndex`。
