# Step 28 — Context Rebuild（SCW 重建协议 + 预算化注入）

**Phase**: H | **依赖**: 27,25 | **可并行**: ❌ | **估时**: 5h

## 目标

实现 **SCW** 创新的第二半：当 context 越过 hard 阈值时，*用 checkpoint + memory + progress + 最近 K 消息*
重建出新的、可继续工作的 messages 列表，并通过 ContextBudget 显式预算化每段大小。

## 产物

```
src/context/
├── rebuilder.ts           # 主流程
├── budgets.ts             # ContextBudget 计算
├── selectors/
│   ├── recentMessages.ts  # 选最近 K 条
│   ├── checkpointPick.ts  # 选最新 checkpoint
│   ├── progressPick.ts    # 选活跃 task progress
│   └── memoryPick.ts      # 复用 step-25 selector
└── index.ts
```

## ContextBudget（接口冻结）

```ts
export interface ContextBudget {
  systemBase: number;       // 基础 system prompt 估算
  memory: number;
  checkpoint: number;
  notes: number;
  taskProgress: number;
  skills: number;           // step-29 用
  tools: number;            // ATP 用
  history: number;          // 剩余分配给消息历史
}

export function computeBudget(model: string, providerId: ProviderId, cfg: ChovyConfig): ContextBudget;
```

预算分配规则（默认 200k 上下文为例）：

| 段 | 比例 | 备注 |
|---|---|---|
| systemBase | 1.5k | 默认 prompt + 静态 |
| memory | 4k | step-25 |
| checkpoint | 3k | step-26 |
| taskProgress | 2k | 当前 goal |
| notes | 1k | 临时 |
| skills | 8k | step-29 |
| tools | 6k | ATP |
| reserve | 4k | 输出 |
| **history** | 剩余 | 通常 ~150k |

## 重建流程

```
function rebuild(messages, ctx): ChatMessage[] {
  // 1. 拉最新 checkpoint（latest.md）
  const cpText = checkpointPick(ctx.projectId, budget.checkpoint);

  // 2. 选 memory（top-K，按 budget.memory）
  const memText = memoryPick({ projectId, prompt: latestUserText, budgetTokens: budget.memory });

  // 3. 选活跃 progress（如有 /goal）
  const progText = progressPick(ctx.activeGoalId, budget.taskProgress);

  // 4. 决定保留的最近 K 条消息（默认 K=8；超 budget.history 时按"重要性 × recency"裁剪）
  const recent = recentMessagesPick(messages, budget.history);

  // 5. 组装新 messages
  return [
    { role:'system', content:
      `<context-rebuilt at="${ts}" reason="hard-threshold">\n` +
      `<checkpoint>\n${cpText}\n</checkpoint>\n` +
      `<memory>\n${memText}\n</memory>\n` +
      (progText ? `<task-progress goal="${ctx.goal.objective}">\n${progText}\n</task-progress>\n` : '') +
      `<note>之前的对话已截断；请基于上述快照继续；如需查阅旧消息，使用 mem search 工具。</note>` +
      `</context-rebuilt>`,
    },
    ...recent,
  ];
}
```

`<context-rebuilt>` 是显式标记——agent 看到即知道发生了什么；用户在 UI 也会看到醒目提示。

## 旧消息保留

完整原始消息流仍写入 `~/.chovy/projects/<x>/sessions/<id>.jsonl`（步骤 04 提供路径）；
agent 可通过新增的 *搜索工具* 调出（可在 step-30 加 `SessionSearchTool`）。

## 重建后的副作用

- 重置 cost-tracker 的"本会话"统计（保留累计）；
- 触发 `ContextRebuilt` 钩子（让用户写自己的逻辑）；
- 写 telemetry：`{ type:'context.threshold', level:'hard', tokens, rebuilt: true }`。

## 与 ATP / Skills 的协同

- ATP 在重建后下一轮自动重算（lean/full 选择）；
- Skills（step-29）在重建后会保留 *已选 skill 链*，但其 systemFragment 由新 budget 重新分配。

## 退化路径

- checkpoint 缺失（首次会话刚 hard）→ 立刻 *同步* 调一次 checkpoint-writer（不 background），等其完成；
- 仍失败 → 用纯规则化摘要：`<rule-summary>...</rule-summary>` 取最近 user msg 的关键句；
- 极端情况 → 直接截断到 `recent K` + system base，让 agent 重新理解任务。

## 验收标准

- 模拟一次 200k 上下文 → 重建为 ~30k；
- 重建后 agent 能基于 checkpoint 继续未完成任务（通过端到端测试：goal-loop 跨 hard 阈值仍达成）；
- ContextBudget 总和 ≤ ctx_window - reserve；
- jsonl 完整保留所有原始消息。

## 参考源

- `cc-haha/src/services/compact/autoCompact.ts`（思路）
- 本步是 chovy-code 的关键差异化点；cc-haha 的 compact 是"模型自总结"，chovy-code 是"结构化拼装"。

## 风险

- 重建破坏正在进行的 tool_use 配对（assistant.tool_use 被丢、tool result 被保留）→ 选取最近消息时优先保持 tool_use/tool_result 配对完整；保险起见从最近消息向后过滤孤立的 tool message。
