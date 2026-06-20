# Step 25 — Memory Injection（TMT 自动注入 + 相关性打分）

**Phase**: G | **依赖**: 24 | **可并行**: ✅ | **估时**: 4h

## 目标

把 store 中的记忆按"用户当前 prompt + 任务上下文"自动注入到 system prompt 的 `[memory]` 段中。
**目标：让 agent 在会话恢复时无需重新理解项目背景**。

## 产物

```
src/memory/
├── injection.ts           # 主入口
├── ranker.ts              # 相关性打分
├── selector.ts            # 预算化选择
└── promptSegment.ts       # 输出 prompt 片段
```

## 注入时机

由 QueryEngine（步骤 16）在每轮调用 provider 之前调用：

```ts
const memSeg = await memory.buildPromptSegment({
  projectId, prompt: userLatest, recentMessages,
  budgetTokens: contextBudget.memory,    // 默认 4000
  agentRole, currentGoal,
});
buildOptions.defaultAppend += '\n' + memSeg.text;
```

也在子 agent 启动时注入到其 ContextSnapshot.memorySummary。

## Ranker（相关度）

```ts
function score(rec: MemoryRecord, query: { text: string; tags?: string[]; role: AgentRole }): number {
  const bm25 = ftsBm25(rec, query.text);                  // 0..1 normalized
  const recency = recencyDecay(rec.updatedAt);            // 30天半衰期
  const importance = rec.importance / 100;
  const layerWeight = LAYER_W[rec.layer];                 // project=1.0, checkpoint=0.9, progress=0.7, notes=0.5
  const typeWeight  = TYPE_W[rec.type];                   // decision=1.0, rule=0.95, snapshot=0.85, ...
  const tagBoost = overlap(rec.tags, query.tags) * 0.2;

  return 0.40 * bm25
       + 0.20 * importance
       + 0.15 * recency
       + 0.10 * layerWeight
       + 0.10 * typeWeight
       + 0.05 * tagBoost;
}
```

## Selector（预算化）

```ts
function select(records: ScoredRecord[], budgetTokens: number): MemoryRecord[] {
  // 1. 按 score 降序
  // 2. 贪心：累加 estimateTokens(rec.content) 直到 budget；
  // 3. 强制保留：layer=project + type=decision 中 importance>=80 的至少 3 条（即便挤掉低分）。
  // 4. 同 type 限流：同一 type 一次最多注入 5 条；
  // 5. 跨任务（layer=progress）：仅当前活跃 goal 的 progress 计入。
}
```

## 输出格式

```
[memory]
## Project Decisions
- (80) we use Bun + Ink, not Node
- (75) provider registry is the only way to add LLMs

## Rules
- (70) commit messages must follow conventional-commits
- (65) prefer explicit return types in TS

## Recent Checkpoint (2 hours ago)
- 完成了 step-15 的 prompt 分区；下一步：实现 PSF。
- 已知问题：windows 下 Ink 闪烁；用 CHOVY_NO_SWARM_PANEL 临时回避。

## Active Task Progress (goal: typecheck)
- round 3: 修复 src/types/messages.ts 中可选字段；剩 2 处错误。

## Notes (most recent 3)
- TODO: 把 ToolBudgetAllocator 的角色亲和度抽出为外部表
[/memory]
```

每条带 importance 的 `(num)` 让 agent 自我感知优先级。

## 显式工具

为便于主 agent 主动写记忆，提供：

```ts
// MemoryWriteTool
schema: z.object({
  layer: z.enum(['project','notes']).default('notes'),
  type: z.enum(['decision','rule','fact','pref','note','reference']),
  content: z.string().max(2000),
  importance: z.number().min(0).max(100).default(50),
  tags: z.array(z.string()).max(8).optional(),
});
```

写入时同时更新对应文件（notes.md / MEMORY.md），落 db。
**MEMORY.md 的写入需要用户确认**（因为是项目级长期记忆），通过权限引擎 ask。

## 跨会话恢复

- SessionStart 钩子时调用 `memory.warmUp(projectId)`：把"全局重要决策" + "最新 checkpoint"预加载到一个内存 cache，以加速首轮注入；
- 如果检测到该项目从未有过 MEMORY.md，提示用户"是否启用项目记忆？"——只有同意后写入。

## 验收标准

- 第二次进入项目时 system prompt 自动出现 [memory] 段；
- budgetTokens=2000 时 [memory] 段不超出；
- 强制保留的高 importance decision 在 budget 紧时仍可见；
- 工具 MemoryWrite 写入 notes 后立刻可被 search 找到。

## 参考源

- `cc-haha/src/memdir/findRelevantMemories.ts`、`memoryAge.ts`

## 风险

- 注入"过度自信"导致 agent 旧决策束缚 → 模板中明确"以上为历史记忆，可被新需求覆盖"。
