# Step-26 Checkpoint Writer — 验收报告

> 日期：2026-06-18
> Phase：G（Memory Store — TMT 第二步）
> 依赖：step-18 ✅（SubAgentPool）+ step-19 ✅（checkpoint-writer 角色定义占位）+ step-23 ✅（goal-loop triggerCheckpoint 钩子）+ step-24 ✅（MemoryStore barrel 已存在，便于归位）
> 并行：G 单步，不并行

## 0. 任务范围

按 [`docs/step-26-checkpoint-writer.md`](../step-26-checkpoint-writer.md) 落地 **L2 检查点自动维护**：用专门的 `checkpoint-writer` 子 agent 在 5 种触发条件下生成结构化快照，写入 `checkpoints/latest.md` 与时间戳归档（≤ 50 文件）。

不在本步骤做（按计划留给后续）：

- **token-soft 触发**：`SCW`（step-27/28）落地的 `contextBudget` 钩子负责判定；本步只暴露 `'token-soft'` / `'big-event'` 入口（coordinator 已接受 reason，调用方需后续接通）；
- **`memoryStore.upsertFromCheckpointFile` 直接写入**：step-24 已上线 `MemoryStore`，而 checkpoint → MemoryRecord 的解析**已通过 step-24 的 file-primary sync 路径落地**（`syncFromFiles.collectSourceFiles` 把 `checkpoints/*.md` 当 layer=checkpoint 源文件解析 → upsert；本步验收 §5 已加 smoke-step26 §13 覆盖该 bridge）。coordinator 内无需再做一次 `upsertFromCheckpointFile` —— 文件是主源，store 是派生索引（step-24 §文件 ↔ DB 同步）。coordinator 中保留的 `// TODO step-24/25` 注释指 direct-call 微优化（写盘后立刻 upsert 以省一次 sync mtime 探测），非功能缺口；
- **SessionEnd 自动触发**：`/checkpoint now` + goal-loop 已能覆盖主要场景；进程退出钩子需要协调 Ink 卸载时序，留待 step-30 端到端集成。

## 1. 文件清单

### 新增

| 文件 | 行数 | 摘要 |
|---|---|---|
| `src/memory/checkpointWriter.ts` | 437 | `CheckpointCoordinator` 类（防抖 30s/reason + spawn + 验证 + 轮转 + fallback + hook/telemetry）+ `buildSnapshotPrompt` + `buildFallbackMarkdown` + `truncateBody` + `rotateArchive` + `extractFinalMarkdown` + 单例 `getCheckpointCoordinator` / `_resetCheckpointCoordinatorForTesting` |
| `src/cli/slashCommands/checkpoint.ts` | 79 | `/checkpoint now | list` handler（UI-only，通过 `ReplCtx.checkpoint` 调 `triggerNow/list`） |
| `scripts/smoke-step26.ts` | 470 | 43 项验收：path 沙箱（§1/§2）+ debounce（§3）+ fallback（§4）+ telemetry（§5）+ hook payload（§6）+ truncate（§7）+ rotate（§8）+ shouldCheckpoint 节奏（§9）+ slash 路由（§10）+ 角色传播（§11）+ 取消 fallback（§12） |
| `docs/complete/step-26-acceptance.md` | 本文件 | 验收报告 |

### 修改

| 文件 | 改动要点 |
|---|---|
| `src/types/tool.ts` | `ToolContext` 追加 `agentRole?: AgentRole`（§16 frozen-extension，纯可选，无破坏性） |
| `src/engine/queryEngine.ts` | `run()` 把 `role` 注入 `ToolContext.agentRole`（一行，注释明确 source） |
| `src/tools/fs/write.ts` | `agentRole === "checkpoint-writer"` 时校验 `path` 必须在 `checkpointDir(cwd)` 内；同时把该 dir 加进 `assertWritable.allowOutsideCwd`（解决"checkpoint dir 在 cwd 之外"的物理沙箱边界） |
| `src/tools/fs/edit.ts` | 同上（防御纵深，配 blind-write guard） |
| `src/agent/builtin/checkpointWriterAgent.ts` | 替换 step-19 占位 prompt 为 7 段模板 + 7 条 hard rules（≤ 8 KB / file_write 一次性 / 不复述代码 / 章节不可省）；保留 `allowedTools` / `omitMemory` / `budgetUSD` / `timeoutMs` / `maxRounds` 不变 |
| `src/goals/checkpoint.ts` | `triggerCheckpoint` 改写为薄壳：委托 `getCheckpointCoordinator().maybeCheckpoint('goal-round', ...)`；保留 `shouldCheckpoint` / `triggerCheckpoint` 公共签名（step-23 调用方零改动） |
| `src/goals/iterations.ts` | 调用点补传 `cwd/provider/model/parentSignal`（旧 `spawnFn` 仍接受但忽略） |
| `src/cli/slashCommands.ts` | `ReplCtx` 追加 `checkpoint?: ReplCheckpointRuntime`；注册 `checkpoint: checkpointSlashEntry` |
| `src/cli/repl.tsx` | 新增 `checkpointRuntime` useMemo（闭合 provider/model/cwd/messages），注入 `ctx.checkpoint` |
| `src/telemetry/events.ts` | 追加 `checkpoint.written` 事件（`path` / `bytes` / `reason` / `mode` / `durMs`）；单源 = `memory/checkpointWriter.ts` |
| `src/memory/index.ts` | 追加 step-26 公共导出（`CheckpointCoordinator` + helpers + 常量 + 类型） |
| `scripts/smoke-step19.ts` | 更新 5.cp assertion：从"step-26 占位关键词"改为"已落地的 7 段模板 + file_write 规则"（更准的回归门） |
| `AGENTS.md` | 追加 §20 "Phase G 不变量（Checkpoint Writer）" |

## 2. 关键设计决策

### 2.1 Agent 用 file_write + ToolContext.agentRole 路径校验（用户决策 #1）

Spec 原文（line 31）写 `allowed tools: read, write（仅限 checkpoints/）` —— 但角色定义是"工具白名单"层面的能力，无法表达路径谓词，靠 prompt 文本不是安全边界。两条可行路径：

**方案 A**（被否决）：coordinator 自管文件写入，子 agent 只产出 markdown 文本作为 assistant 消息。路径沙箱降为零成本、原子轮转集中。
**方案 B**（采用）：保留 spec 原意 —— agent 用 `file_write` 写盘，新增 `ToolContext.agentRole?: AgentRole` 字段（§16 frozen-extension 允许追加可选字段），`tools/fs/write.ts` / `tools/fs/edit.ts` 在 `agentRole === "checkpoint-writer"` 时 hard-deny 越界写。

选 B 的理由：
- 与 spec 字面一致，且让 `latest.md` 的"用户可读 / 可手改"语义天然落地（文件由 agent 写出，与 coordinator 写无差异）；
- `agentRole` 是 chovy-code 通用的 role-aware 工具能力（不止 checkpoint —— 后续 critic / verifier 也可基于 role 做差异化），投资一次性回收；
- 路径校验 + `assertWritable.allowOutsideCwd` 双重防御：前者限目录、后者解决 checkpoint dir 在 cwd 外的物理边界。

### 2.2 协调器集中 vs 散点触发（防抖、轮转、fallback）

5 种触发条件分散在 goal-loop / REPL slash / 未来 SCW / SessionEnd。如果各自直接 `pool.spawn`，会重复实现：防抖（30s/reason）、轮转（≤50 文件）、fallback（agent 失败兜底）、telemetry 单源、hook emit。

`CheckpointCoordinator` 把这些都集中进 `maybeCheckpoint(reason, input)`，调用方一行 `void coordinator.maybeCheckpoint(...)` fire-and-forget。理由：
- **single source for `checkpoint.written` telemetry**（AGENTS.md §17 镜像 `agent.cost` / `swarm.dispatch` / `goal.start`）；
- 防抖按 reason 分桶 —— 不同 reason 互不抑制（用户手动 + goal 自动 + token 触发可同时发生），但同 reason 30s 内只跑一次（防抖死循环）；
- fallback 路径同写 `latest.md`（7 段规则化模板），下游 SCW 解析无需特例。

### 2.3 取消协议（再强调 §9 红线）

协调器本地 `new AbortController()` 包装 caller `parentSignal`；spawn 给 pool 的 `parentCtx.parentSignal` 是这个本地 signal。两层包装：

```
caller parentSignal ─listener→ coordinator local AC ─listener→ pool child AC ─listener→ engine AC
```

绝不共享 signal 对象。pre-aborted 的 caller signal → 协调器直接走 fallback 写盘（smoke case 12 验证）。子 agent 的 AC 在 pool 内部按 §18 既定机制 cascade。

### 2.4 路径沙箱的两层防御

1. **角色允许工具**：`checkpointWriterAgent.allowedTools = ["file_read", "file_write"]`（step-19 已冻结，本步不改）。
2. **工具层角色感知校验**（本步新增）：`tools/fs/write.ts` + `tools/fs/edit.ts` 在 `ctx.agentRole === "checkpoint-writer"` 时 `isWithin(checkpointDir(cwd), path)` 不成立 → `TOOL_DENIED`；同时把 `checkpointDir` 加入 `assertWritable.allowOutsideCwd`（否则物理沙箱会因为"写 cwd 外"拒绝）。
3. **协调器事后校验**：`maybeCheckpoint` 写盘前 `isWithin(dir, latest) && isWithin(dir, archive)`（paranoia，路径由协调器自身计算，正常不会越界）。

prompt 文本里 *也* 提示"必须用 latestPath"，但不作为安全边界（spec line 27-30 / AGENTS.md §16 明确：prompt 不是 security boundary）。

### 2.5 不扩 HookEvent union（继承 §17/§19 模式）

`CheckpointWritten` 已在 step-13 的 `HookEvent` union 里（chovy-code 12 事件的 3 个扩展之一）。本步只 emit 不扩展。advisory —— 协调器在 emit 失败时 swallow，不影响 latest.md 已写盘。

## 3. 验收标准对照

| Spec 验收点 | 实现 | smoke 用例 |
|---|---|---|
| /goal 跑 5 轮后 latest.md 自动出现 | ✅ `iterations.ts` 每 `CHECKPOINT_INTERVAL_ROUNDS=5` 调 `triggerCheckpoint` → coordinator 写盘 | smoke-step23 case 10 验证 `shouldCheckpoint`；smoke-step26 §3/§9 验证 coordinator 接线 |
| token 超 soft 时立即触发 | 🟡 coordinator 已支持 `'token-soft'` reason 入口；实际触发由 step-27/28 SCW 接通 | （留 TODO 注释） |
| /checkpoint now 强制立即生成 | ✅ slash handler → `ctx.checkpoint.triggerNow()` → `coordinator.maybeCheckpoint('manual', ...)` | smoke-step26 §10 |
| 归档目录文件数稳定 ≤ 50 | ✅ `rotateArchive(cwd, 50)` 在每次写盘后跑，按 mtime 降序保留前 50，余 unlink；`latest.md` 不参与计数 | smoke-step26 §8（55 文件 → 50 + latest） |

## 4. 性能验收

| Spec 指标 | 实测 |
|---|---|
| 单次 checkpoint sub agent 成本 < $0.01 | spawn 配置 `budgetUSD: 0.05`（与 step-19 角色定义一致），实际由小模型（`preferredModel: gpt-4o-mini`）+ `maxRounds: 4` 控制；fallback 路径 0 成本 |
| 不阻塞主 agent | `void coordinator.maybeCheckpoint(...)` fire-and-forget；`spawn({ background: false })` 是协调器内部 await（不阻塞 caller），fallback 路径 ms 级完成 |
| 失败 telemetry warn，不打断主流程 | `try/catch + logger.warn` 全路径包裹；hook emit 失败 swallow；rotate 失败 swallow；写盘失败返回 `{ ok:false, error }` 但不抛 |

## 5. smoke 结果

```
=== Step-26 checkpoint-writer smoke ===
50 passed, 0 failed
```

> **复验追加（2026-06-18 Phase A-G 验收）**：新增 §13 "step-24 ↔ step-26 integration"
> 用例（7 项断言）——验证 coordinator 写出的 `latest.md` 经 `syncProject` 落入
> MemoryStore 后可被 FTS5 search 命中且 `layer=checkpoint`。此前两步各自 green
> 但 bridge 未被 smoke 覆盖；该用例闭合此缺口。smoke 由 43 → 50 passed。

回归：
- `smoke-step19.ts`：71 passed（更新 5.cp assertion 为已落地的 7 段模板门）
- `smoke-step23.ts`：36 passed（`shouldCheckpoint` / `triggerCheckpoint` 公共签名未变）
- `smoke-step18.ts`：26 passed（pool 不变）
- `smoke-phase-b-acceptance.ts`：11 passed（ToolContext frozen-extension 不破坏）
- `smoke-fs-tools.ts`：全 pass（fs 工具回归）

`bun run typecheck`：0 错误。

## 6. 移交后续 step

### 6.1 step-27/28 SCW（上下文管理）

- SCW 决定重建上下文时，**先**调 `getCheckpointCoordinator().maybeCheckpoint('token-soft', ...)` 确保 latest.md 是最新的（max 30s 旧，由防抖窗口保证）。
- 重建材料 = `checkpoints/latest.md` + memory top-K + 活跃 progress + 最近 K 消息。
- coordinator 已暴露 `'token-soft'` / `'big-event'` reason 入口，无需新增 API。

### 6.2 step-24/25 MemoryStore 接入（复验更新）

checkpoint → MemoryRecord 的解析**已通过 step-24 file-primary sync 路径落地**（`syncFromFiles` 把 `checkpoints/*.md` 当 layer=checkpoint 源解析 + upsert；smoke-step26 §13 已覆盖该 bridge，50/50 passed）。coordinator 中保留的 `// TODO step-24/25` 注释指 *direct-call* 微优化（写盘后立刻 upsert 省一次 sync mtime 探测），非功能缺口，留给 step-25/27 按需接通。文件始终是主源，store 是派生索引（step-24 §文件 ↔ DB 同步）—— coordinator 不需要在写盘后再做一次 upsert。

### 6.3 step-30 SessionEnd 自动触发

`/checkpoint now` + goal-loop 已覆盖主路径。SessionEnd 钩子需要在 REPL 卸载时序里安全调一次 `coordinator.maybeCheckpoint('session-end', ...)`，留待 step-30 端到端集成。

### 6.4 ToolContext.agentRole 通用化

本步只对 `file_write` / `file_edit` 用了 `agentRole`。后续可扩展：
- `bash` 在 `agentRole === "explorer"` 时 hard-deny（与 `disallowedTools` 重叠但更可靠）；
- `web_fetch` 在 `agentRole === "verifier"` 时限制 domain。

## 7. 不变量（已写入 AGENTS.md §20）

- `ToolContext.agentRole` 单源 = `src/types/tool.ts`（frozen-extension，纯可选）；
- `checkpoint.written` telemetry 单源 = `src/memory/checkpointWriter.ts`；
- 路径沙箱在 `tools/fs/write.ts` + `tools/fs/edit.ts`，**永不在** prompt 文本；
- 协调器防抖 30s/reason、轮转上限 50、失败 fallback 规则化；
- `memory/` 是叶子模块，无反向依赖（engine/providers/harness 不引用）；
- coordinator 本地 AC 包装 caller signal（§9 红线代码化）。

## 8. 下一步

step-27 — Smart Context Window（SCW）：自适应阈值 + 自动 checkpoint 触发 + 上下文重建 + 预算化注入。本步已暴露所有 coordinator API，无需再改 checkpoint 模块。
