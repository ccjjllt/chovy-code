# Step 26 — Checkpoint Writer Sub-Agent（自动结构化快照）

**Phase**: G | **依赖**: 24,18 | **可并行**: ❌（依赖 sub-agent runtime） | **估时**: 4h

## 目标

实现 **L2 检查点自动维护**：用一个专门的 *checkpoint-writer 子 agent*，按触发条件
自动生成 *结构化* 会话快照，写入 `checkpoints/latest.md` 与时间戳归档。

## 产物

```
src/memory/checkpointWriter.ts      # 协调器（决定何时调用）
src/agent/builtin/checkpointWriterAgent.ts  # 子 agent 定义（步骤 19 已占位）
```

## 触发条件（OR）

1. **token 阈值**：上下文 token 越过 `soft`（默认 75%）；
2. **轮数阈值**：goal-loop 每 N=5 轮；
3. **手动**：`/checkpoint now` 斜杠命令；
4. **会话结束**：`SessionEnd` 钩子；
5. **重大事件**：dispatch 完成、长 BashTool 完成、Edit 大量文件后。

## 子 agent 行为

定义（在 step-19 中已占位）：

- role: 'checkpoint-writer'
- allowed tools: `read`, `write`（仅限 checkpoints/）
- preferredModel: 小模型（gpt-4o-mini / glm-4-air）
- omitMemory: true（自己就是写记忆的，不再注入）
- system prompt：

```
你是 checkpoint-writer。任务：从下面会话片段中提炼结构化快照，写入 ~/.chovy/projects/<id>/checkpoints/latest.md。

模板（严格遵守，markdown 格式）：

# Checkpoint <ISO ts>
## Goal
<当前 /goal 的 objective；若无则写 'ad-hoc'>

## Done in this session
- ...

## In Progress
- ...

## Decisions
- ...

## Files touched
- path: 简述

## Open questions / Risks
- ...

## Next intended steps
1. ...
2. ...

不要超过 8KB。不要复述完整代码；只记关键句。
```

写入 `checkpoints/latest.md`（覆盖）+ `checkpoints/<ISO ts>.md`（归档，最多保留 50 个，超出按时间删除）。

## 协调器流程

```ts
class CheckpointCoordinator {
  async maybeCheckpoint(reason: string, ctx: ToolContext): Promise<void> {
    if (debouncedRecently(reason)) return;            // 30s 防抖
    const handle = await ctx.spawnSubAgent({
      role: 'checkpoint-writer',
      prompt: buildSnapshotPrompt(ctx.session),       // 包括最近 K 条消息 + 当前 goal + 当前 progress
      tools: ['read', 'write'],
      shareSession: false,                             // 不再注入父 snapshot（避免循环）
      contextSnapshotOverride: minimalSnapshot(ctx),
      background: true,
      budgetUSD: 0.05,
      timeoutMs: 30_000,
    });
    handle.onFinish(() => {
      memoryStore.upsertFromCheckpointFile(latestPath);
      hooks.run('CheckpointWritten', { path: latestPath });
    });
  }
}
```

## 与 SCW 的协同（step-27,28）

- 当 SCW 决定 *重建* 上下文时，必须先确保 checkpoint 是最新的（max 30s 旧）；
- 重建材料 = `checkpoints/latest.md` + memory top-K + 活跃 progress + 最近 K 消息；
- 即：checkpoint 是 SCW 的 *输入*，不是它的副产品。

## 用户可读

`checkpoints/latest.md` 是普通 markdown 文件，用户随时可打开看；
也可以手改——下次注入时以文件为准（store 会重新解析）。

## 性能

- checkpoint sub agent 单次成本应 < $0.01；
- 不阻塞主 agent（background=true）；
- 失败时 telemetry warn，不打断主流程。

## 验收标准

- /goal 跑 5 轮后 latest.md 自动出现；
- token 超 soft 时立即触发；
- /checkpoint now 强制立即生成；
- 归档目录文件数稳定 ≤ 50。

## 参考源

- `cc-haha` 中并无完整对应实现；checkpoint 思路源自 codex / cline 的 "context resume" 设计。

## 风险

- checkpoint 内容质量不稳定 → 模板严格 + 失败时回退用 *规则化* 摘要（仅取 last user msg + last assistant msg）。
