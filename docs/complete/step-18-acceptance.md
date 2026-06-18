# Step-18 Sub-Agent Runtime — 验收报告

> 日期：2026-06-18
> Phase：E（Sub-Agent System）第一步
> 依赖：step-16 ✅
> 后续可并行：step-19 / step-20

## 0. 任务范围

按 [`docs/step-18-sub-agent-runtime.md`](../step-18-sub-agent-runtime.md) 落地子智能体运行时，
覆盖 **生命周期 / 取消 / 后台执行 / 父→子上下文共享**，并在 `architecture.md §3.3`
所列的接口冻结时点固化 `SubAgentHandle` / `AgentLifecycle` 等类型。

不在本步骤做（按计划留给后续）：
- 内置 4 角色（Explore/Plan/Verify/Critic）的 system prompt — step-19
- Swarm `dispatch(N)` 并发分发 / Judge 聚合 — step-20 / step-21
- Ink UI 子 agent 面板 — step-22
- 记忆 / checkpoint 注入实质内容 — step-25 / step-26
- `bin/chovy.js` 重构产物（构建产物本步骤不动）

## 1. 文件清单

### 新增

| 文件 | 行数 | 摘要 |
|---|---|---|
| `src/agent/lifecycle.ts` | ~155 | `SubAgentHandle` 状态机；合法跃迁表 + `setStatus / finalize / setPhase / addUsage / makeHandle / makeSubAgentId` |
| `src/agent/snapshot.ts` | ~110 | `buildParentSnapshot` + `formatSnapshotXml`（XML 渲染、tool 消息过滤、字段非空裁剪） |
| `src/agent/pool.ts` | ~310 | `InMemoryPool` + `getSubAgentPool` 单例、cap 100、级联 abort、timeout watchdog、`subagent.spawn/end` 单源发射 |
| `scripts/smoke-step18.ts` | ~290 | 覆盖 6 组验收：lifecycle、snapshot、cap 100、cancel ≤ 2s、background 立即返回、parent 信号级联（不共享 AC） |

### 修改

| 文件 | 摘要 |
|---|---|
| `src/types/agent.ts` | **冻结** `SubAgentHandle`（增 `background / cancel() / result: SubAgentResult`），新增 `SubAgentResult / SpawnInput / ParentContextSnapshot / ParentRuntimeCtx / SpawnFn / AgentStatus`（`AgentLifecycle` 别名）。 |
| `src/types/tool.ts` | `SpawnFn` 占位换为强类型 `import type` 自 `types/agent.ts`（barrel 单源；不重复 export） |
| `src/telemetry/events.ts` | 增 2 个事件：`subagent.spawn` / `subagent.end`，含 `id / parentId / role / background / status / costUSD / durMs`，文档化"单源 = pool" |
| `src/agent/runAgent.ts` | 在 module top-level 调 `setSpawnFnBuilder(...)` 注册 spawn 工厂；用 `getSubAgentPool().spawn(input, { parentCtx })` 包装 |
| `src/agent/index.ts` | 重写 barrel，导出 pool / lifecycle / snapshot 全套 API |
| `src/engine/queryEngine.ts` | 新增 `SpawnFnBuilder` + `setSpawnFnBuilder()`；run() 中检测 `role === "main"` 时调用 builder 构造 `parentCtx`（含 *live* messages 数组引用）注入 `ctx.spawnSubAgent` |
| `src/engine/index.ts` | 导出 `setSpawnFnBuilder` / `SpawnFnBuilder` |
| `src/engine/streamHandler.ts` | **bug fix**：`runStream` 快路径未把 abort signal 转发给 `provider.complete()`，导致非流式 sub-agent 无法取消。本次顺手修掉以满足 step-18 验收 §3 |
| `src/providers/registry.ts` | 增 `_unregisterProviderForTesting(id)`（test-only escape hatch；smoke 用它 hijack `openai` slot） |
| `src/providers/index.ts` | 公开 `registerProvider` + `_unregisterProviderForTesting` |
| `src/tools/meta/agent.ts` | 重写：`ctx.spawnSubAgent` 已注入 → 把 `subagent_type` 大小写映射到 `AgentRole`，构造 `SpawnInput` 调用，按 `background` 决定 `wait` 或 `fire-and-forget`，结果落 `structuredOutput`；缺失 runtime 仍返回 `INTERNAL` 但理由换成"no-runtime"指向 step-20 |
| `scripts/smoke-step11.ts` | 适配新 SpawnFn 强类型：no-runtime case 检 `kind === "no-runtime"`；wired case 用真 `SubAgentHandle` 形状作为 stub 返回 |

## 2. 类型冻结摘要（架构 §3.3）

```ts
// SubAgentHandle 字段（最终版）：
//   id: 'sa_' + base36(8)
//   parentId / role / prompt
//   status: AgentLifecycle           // queued | running | done | failed | cancelled | paused
//   phase: string
//   spawnedAt / finishedAt? / costUSD / tokensIn / tokensOut
//   provider? / model?
//   background: boolean              // ★ step-18 新增
//   cancel(): Promise<void>          // ★ step-18 新增（幂等）
//   result?: SubAgentResult          // ★ ChatMessage[] → SubAgentResult（draft → frozen）

// SubAgentResult / ParentContextSnapshot / ParentRuntimeCtx / SpawnInput / SpawnFn 全部
// 在 src/types/agent.ts 单源声明；types/tool.ts 仅 import type，不 re-export，避免 barrel 冲突。
```

### 命名取舍

- spec 写 `AgentStatus`，代码用 `AgentLifecycle`。后者已在 step-01 落地并被 `architecture.md §4.1`
  / `goal.ts` 引用；`AgentStatus` 留作 `type AgentStatus = AgentLifecycle` 别名以匹配 spec 描述。
- spec 写 `ContextSnapshot`，但 `src/types/context.ts` 已经为 SCW（step-27/28）占用此名。
  step-18 改名 **`ParentContextSnapshot`** 以避免冲突；这是命名层面的差异，行为与 spec 完全一致。

## 3. AGENTS.md 不变量遵守情况

| 规则 | 实现位置 | 说明 |
|---|---|---|
| §9 子 agent 必须自有 AbortController（不共用父 signal） | `pool.ts:144-156` | 每个 handle 一个 `new AbortController()`；父 signal 仅作为 `addEventListener("abort", () => childAc.abort())` 的触发源；从未把父 signal 传进 `engine.run` |
| §16 单源规约 | `types/agent.ts` 单一声明 + `types/tool.ts` 仅 `import type`；`telemetry/events.ts` `export type` 透传 | barrel 不重复导出 SpawnFn / SubAgentHandle |
| §17 telemetry 单源 = pool | `pool.ts:emitTelemetry({ type: "subagent.spawn"/"subagent.end" })` 仅在此一处 | `agent.start/end` 仍由 QueryEngine 单源发射，与本步骤事件正交 |
| §17 取消信号 | `pool.runChild` 把 `entry.ac.signal` 传给 `engine.run` 作为 `abortSignal`，由 engine 内部再包一层 AC（双层包装与父隔离） | 满足"engine 不污染调用方 signal" |
| §17 cancelGraceMs | 直接复用 QueryEngine 的默认 2000ms grace；timeout 触发的状态记 `failed`（非 `cancelled`），便于区分用户意图与运行时强行终止 | 见 `pool.runChild` 的 `timedOutRef()` 分支 |
| §8 单文件 ≤ 600 行 | `pool.ts` 310；`lifecycle.ts` 155；`snapshot.ts` 110；`queryEngine.ts` 增量 ≈ 25 行（仍 < 600） | 通过 |

## 4. 验收标准（spec §验收标准）

| # | 标准 | 实测 | 来源 |
|---|---|---|---|
| 1 | 父 agent 调用 `agent` 工具能拿到 handle | ✅ | `smoke-step11`: `agent: spawnSubAgent received SpawnInput with role=verifier` + `agent: result content references background sub-agent id` |
| 2 | `background=true` 时父 agent 可继续其它工具 | ✅ | `smoke-step18`: `bg: pool.spawn returns ≤ 200ms` + `bg: status === running` + `bg: handle.background === true` |
| 3 | 取消能在 ≤ 2s 内反映在 `handle.status` | ✅ | `smoke-step18`: `cancel: handle reaches terminal` + `cancel: status === cancelled` + `cancel: ≤ 2000ms wall-clock` + `cancel: result.reason set` |
| 4 | 100 个并发 spawn 后第 101 个抛错 | ✅ | `smoke-step18`: `pool: 100 concurrent spawns succeed` + `pool: 101st spawn throws AGENT_BUDGET_EXCEEDED` + `pool: cancelAll drains active count to 0` |
| — | 类型检查 | ✅ | `bun run typecheck` 0 错 |
| — | step-11 兼容性 | ✅ | `bun scripts/smoke-step11.ts` 45/45 通过（无回归） |
| — | step-18 完整 smoke | ✅ | `bun scripts/smoke-step18.ts` 26/26 通过 |

### 额外覆盖（非 spec 必需但合理）

- 状态机非法跃迁（terminal → running）抛 `ChovyError("INTERNAL")` ✅
- `formatSnapshotXml` 过滤 tool 消息（防 tool_call_id 失配） ✅
- 父 abort 经 listener 级联到 child（**未共享 signal**）→ child 终止 ✅
- `isTerminal` 终结状态后 `setPhase` 不覆盖 phase 标签 ✅（lifecycle.ts:131）

## 5. Smoke 输出

```
=== Step-11 meta tools smoke ===
  ... (omitted)
  PASS  agent: no-runtime refuses with INTERNAL
  PASS  agent: no-runtime msg references runtime / step-18 wiring
  PASS  agent: structuredOutput kind=no-runtime
  PASS  agent: wired call delegates and returns ok
  PASS  agent: spawnSubAgent received SpawnInput with role=verifier
  PASS  agent: result content references background sub-agent id
  ...
=== 45 passed, 0 failed ===

=== Step-18 sub-agent runtime smoke ===
  PASS  lifecycle: initial status queued
  PASS  lifecycle: queued → running ok
  PASS  lifecycle: running → done ok
  PASS  lifecycle: terminal stamps finishedAt
  PASS  lifecycle: terminal → running throws INTERNAL
  PASS  snapshot: recentMessages slice (k=6 default)
  PASS  snapshot: parentRole=main
  PASS  snapshot: objective propagated
  PASS  snapshot: xml has root tag
  PASS  snapshot: xml includes parent-role
  PASS  snapshot: xml omits tool messages
  PASS  snapshot: xml escapes lt/gt
  PASS  snapshot: xml includes objective
  PASS  pool: 100 concurrent spawns succeed
  PASS  pool: 101st spawn throws AGENT_BUDGET_EXCEEDED
  PASS  pool: cancelAll drains active count to 0
  PASS  cancel: handle starts running
  PASS  cancel: handle reaches terminal
  PASS  cancel: status === cancelled
  PASS  cancel: ≤ 2000ms wall-clock
  PASS  cancel: result.reason set
  PASS  bg: pool.spawn returns ≤ 200ms
  PASS  bg: handle.background === true
  PASS  bg: status === running
  PASS  cascade: parent abort propagates to child terminal
  PASS  cascade: parent signal still under parent control (not child's signal)
=== 26 passed, 0 failed ===
```

## 6. 工程注意点（移交后续 step）

1. **SpawnFn 仅在 `role === "main"` 注入**：sub-agent 自身不能再 spawn，避免到 step-20
   SwarmR 落地前的隐式递归。step-20 / step-19 决定哪些角色继承 SpawnFn 时，请直接修改
   `queryEngine.ts:251` 的判断条件。

2. **streamHandler 修复（顺手 bug）**：原 `runStream` 快路径不向 `provider.complete()`
   转发 `signal`，导致非流式 sub-agent 无法响应 abort。step-18 必须修才能通过验收 §3。
   修复方式仅是把 `reqWithSignal` 提到外层、快路径也用上；语义无回归（流式路径行为不变）。

3. **`SubAgentHandle.result` 类型升级**：从 draft 的 `ChatMessage[]` 改为
   `SubAgentResult`。grep 证实生产代码没有读 `.result` 字段（仅 `goal.ts` 持有 `SubAgentHandle[]`），
   因此本次升级不破坏既有调用点。step-23 `/goal` 用得到这个 result 的具体内容。

4. **`ContextSnapshot` 命名冲突**：`src/types/context.ts`（SCW）与 step-18 spec 描述
   的"父→子上下文快照"同名。代码层使用 **`ParentContextSnapshot`**；后续 step-25/26
   填实快照内的 `memorySummary / activeTaskProgress / decisions` 时，请保持这个名字。

5. **测试辅助 `_unregisterProviderForTesting`**：仅 smoke 测试用。生产代码、CLI、子 agent
   运行时 **不得** 调用该函数。命名前缀 `_` + 后缀 `ForTesting` 让 grep 一眼可识。

6. **配额默认值**（`pool.ts` 顶部常量）：
   - `MAX_SUB_AGENTS = 100`（spec §池与上限）
   - `DEFAULT_MAX_ROUNDS = 12`（spec §配额与熔断）
   - `DEFAULT_BUDGET_USD = 0.20`（同上）
   - `DEFAULT_TIMEOUT_MS = 120_000`（同上）
   step-19 / step-20 / step-23 可按角色覆盖；不要在使用点硬编码不同的默认。

## 7. 与 cc-haha 借鉴的对比

借鉴：
- AgentTool 子类型枚举（`Explore/Plan/Verify/Critic`）：保留 schema 字面量以便模型迁移；
  内部转 `AgentRole` 小写。
- 每个子 agent 一个独立 AbortController（cc-haha `runAgent.ts:520-528`）：实现一致。
- `omitClaudeMd` 节省 token 思路：chovy 等价物是 `BuiltInAgentDefinition.omitMemory`
  + Layer-2 prompt 不注入动态 memory（已在 step-15 builder 实现）。

差异化（坚持创新）：
- **SwarmR + Judge**：cc-haha 没有结构化裁判输出（step-21 才落地）。
- **TMT 4 层记忆**：cc-haha 的 sidechain transcript 主要是日志；chovy 的快照将来由 TMT 注入。
- **SCW 智能上下文**：cc-haha autocompact 是单一阈值；chovy 用 `softLimit/hardLimit` +
  分桶预算（step-27/28）。
- **PSF**：cc-haha 没有跨 provider 通用化；本次 sub-agent run 同样会发射 `prompt.shape`
  事件（QueryEngine 自带），可用于诊断 sub-agent 提示稳定性。

## 8. 下一步

按 `docs/README.md §1`：

- step-19 — 内置 4 个 agent 角色（依赖本步骤的 `SpawnInput.role`）
- step-20 — SwarmR `dispatch(N)`（依赖 pool / handle）
- step-22 — Ink UI 子 agent 进度面板（依赖 `subagent.spawn/end` 事件 + handle 字段）
- step-23 — `/goal` 长程任务（依赖 handle.cancel + paused 跃迁）

接口冻结后，以上 4 个 step 可在不同 worker 同时推进。
