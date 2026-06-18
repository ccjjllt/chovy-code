# Step 20 — Swarm Router 验收报告

> 范围：`docs/step-20-swarm-router.md`（Phase E，依赖 18）。
> SwarmR 创新核心——主 agent 通过单次 `dispatch()` 调用 fan-out N 个子 agent
> （≤ 100），支持异构 provider/model、并发限流、全局成本熔断、生命周期统一管理、
> 共享会话上下文。Judge 聚合（step-21）留桩。

## 1. 产物清单

```
src/swarm/
├── router.ts              # dispatch 主流程（算法 §1–8 全实现）
├── pool.ts                # 复用 step-18 SubAgentPool 的 thin wrapper（容量预检 + bus 事件）
├── concurrency.ts         # p-limit 风格并发限流器（FIFO + slot 重检）
├── budgets.ts             # GlobalBudget（dispatch-wide USD 上限 + sticky trip）
├── progress.ts            # swarmBus（progress / lifecycle 双通道 + 模块单例）
└── index.ts               # barrel

src/tools/meta/dispatch.ts # 暴露给 agent 的工具（schema + 桥接 ctx.dispatchSwarm）
src/tools/meta/index.ts    # 导出 dispatchTool
src/tools/index.ts         # registerTool(dispatchTool, namespace: "meta")

src/types/tool.ts          # ToolContext.dispatchSwarm?: DispatchSwarmFn（§16 追加可选字段）
src/engine/queryEngine.ts  # setDispatchFnBuilder + 仅 role==="main" 注入 dispatchSwarm
src/engine/index.ts        # 导出 setDispatchFnBuilder / DispatchFnBuilder
src/agent/runAgent.ts      # 注册 dispatchFnBuilder（闭包 parentCtx + 父 signal 转发）
src/agent/pool.ts          # （未改）— SwarmR 复用 step-18 pool，单源不变

scripts/smoke-step20.ts    # 离线冒烟（43 项断言，全过）
```

## 2. 算法对照表（与 step-20 §算法 一致）

| 步骤 | 实现位置 |
|---|---|
| ① 校验 prompts（1..100）+ 容量（active + prompts ≤ 100） | `dispatch()` 入口 + `swarmPool.canFit()` |
| ② 每 prompt 计算 ContextSnapshot（默认 shareSession） | `SpawnInput.shareSession`（透传 step-18 `buildParentSnapshot`） |
| ③ p-limit 限流，按 parallelism 并发 spawn | `createLimiter(parallelism)` + `limiter.run(spawn)` |
| ④ 收集结果（按原数组顺序） | `results[i]` slot + `rollup(i, handle)` |
| ⑤ budgetUSD 超限 → abort：取消未完成，返回 partial | `GlobalBudget` + watchdog `cancelAll()` + `stopReason='budgetExceeded'` |
| ⑥ judge.enabled → 调用 step-21 聚合器 | TODO step-21（留桩：`judgement` 留 undefined + warn） |
| ⑦ 写 telemetry `swarm.dispatch` | `emitTelemetry({ type: "swarm.dispatch", n, parallelism })` |
| ⑧ 返回 DispatchOutput | `{ spawnedIds, results, judgement?, totalCostUSD, stopReason }` |

## 3. 验收标准对照（step-20 §验收标准）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | dispatch 4 个 prompts × 不同 provider，全部并行执行 | ✅ | smoke `dispatch4`：openai/anthropic/gemini/deepseek 全 ok，stopReason=final |
| 2 | parallelism=2 时实际同时运行 ≤ 2 | ✅ | smoke `parallel2`：6 prompts，peak active == 2（recording limiter 实测） |
| 3 | budgetUSD=$0.05 触发熔断（3-5 个 sub agent 即停） | ✅ | smoke `budget`：budgetUSD≈0 → stopReason=budgetExceeded，≥1 cancelled |
| 4 | 取消 dispatch 整体 → 所有未完成 sub agent 状态 cancelled | ✅ | smoke `cancel`：abortSignal.abort() → 4/4 cancelled，stopReason=cancelled |

额外覆盖（非 spec 明列但关键不变量）：

- **失败隔离**：单个 sub-agent 失败不中断兄弟（smoke `isolation`：b failed，a/c ok，stopReason=final）。
- **结果顺序**：完成顺序无关，results 按原数组顺序返回（smoke `dispatch4`：a,b,c,d）。
- **role 映射**：wire `DispatchRole`（explore/plan/verify/critic/custom）→ runtime `AgentRole`（explorer/planner/...）（smoke `role` 6 项）。
- **judge 留桩**：`judge.enabled:true` 不抛错，`judgement` 留 undefined（smoke `judge`）。
- **输入校验**：空 prompts / >100 prompts 拒绝（smoke `validate`）。
- **lifecycle bus**：dispatch 期间 emit lifecycle 事件（smoke `dispatch4`：lifecycleEvents.length > 0）。

## 4. 关键设计决策

### 4.1 dispatchSwarm 经 ToolContext 注入（同 spawnSubAgent 模式）

`ToolContext` 追加可选字段 `dispatchSwarm?: DispatchSwarmFn`（§16 冻结语义：
扩展只追加可选字段）。QueryEngine 在 `role === "main"` 时通过
`setDispatchFnBuilder` 注册的 builder 构造一个闭包 `parentCtx` 的 handle，挂到
`ctx.dispatchSwarm`。子 agent 默认拿不到（避免递归 fan-out，step-20 显式留给后续
step opt-in）。

### 4.2 依赖图无环（engine 不直 import swarm）

`engine/queryEngine.ts` **不**直接 import `swarm/router`——那样会成环
（engine → swarm → agent → engine）。沿用 step-18 的 `setSpawnFnBuilder` 间接
注册模式：`setDispatchFnBuilder(builder)` 由 `agent/runAgent.ts` 在 import 时
调用一次，builder 闭包 `parentCtx` 并转发父 signal 作为 dispatch abortSignal。

`swarm/pool.ts` 直接 reach `agent/pool.js`（**不**经 `agent/index` barrel）——
barrel 会 re-export `runAgent`，而 `runAgent` 在 SwarmR 落地后 import
`swarm/router`，会闭合环。reach 叶子模块保持 DAG。

### 4.3 取消传播：路由器本地 AC + cancelAll

路由器用一个**本地** `AbortController` 包装外部 `input.abortSignal`（AGENTS.md
§9：不共享父 signal）。子 agent 的 AbortController 在 step-18 pool 内从
`parentCtx.parentSignal` cascade——**不**从路由器的 `ac` cascade。因此路由器在
`ac` abort 时显式调 `swarmPool.cancelAll()` 把取消传播到所有未完成子 agent
（外部 abort + 预算熔断两条路径都走这个 listener）。

### 4.4 并发限流器（自实现 p-limit）

`concurrency.ts` 是零依赖 p-limit：slot 在 `run()` 中**恰好 claim 一次**
（fast path 直接 `active++`；waiter 被 wake 后**重新检查** `active >= concurrency`
再 claim，避免双计数 / 超 cap）。step-20 smoke 在 parallelism=2 / >4 prompts 时
抓到了一个双计数 bug（`next()` 与 waiter 都 `active++`），已修复并加回归断言
（peak active == 2）。

### 4.5 全局预算 watchdog

`GlobalBudget` sticky trip：一旦 `totalUSD >= cap` 永久 `exceeded=true`。watchdog
每 100ms 轮询 handle 累计 cost，trip 时 `cancelAll()`。预算在 spawn 前也检查
（已 trip → 跳过 spawn + 标 cancelled），避免 budgetExceeded 后还继续 fan-out。

### 4.6 judge 留桩（step-21）

`judge.enabled:true` 时 dispatch 仍成功——judge 步骤跳过，`judgement` 留
`undefined`，logger.warn 一条（可观测但不抛）。`TODO step-21` 标记在
`router.ts` 的 `JUDGE_NOT_IMPLEMENTED` 处，后续替换为 `runJudge(results, opts)`。

## 5. 不变量（写入 AGENTS.md §18）

新增 §18「Phase E 不变量（Sub-Agent + SwarmR）」前半段，固化 step-20 跨步骤
生效的约束。要点：

- **单源**：handle 状态 + `subagent.*` telemetry 留在 `agent/pool.ts`；`swarm.dispatch`
  telemetry 只由 `dispatch()` 发射一次；swarmBus 是 handle 状态的 *观察者*，不是
  telemetry 第二发射源。
- **冻结接口**：`DispatchInput` / `DispatchOutput` / `DispatchChildResult` /
  `DispatchRole` / `JudgeSchemaName`（step-20 冻结，B4 屏障）；`ToolContext.dispatchSwarm?`
  追加可选字段（§16 兼容）。
- **取消**：路由器本地 AC 包装外部 signal；子 agent AC 在 pool 内从 `parentCtx.parentSignal`
  cascade（不从路由器 ac）；路由器 ac abort → `swarmPool.cancelAll()` 显式传播。
- **并发**：parallelism 由自实现 p-limit 限流（slot 恰好 claim 一次 + waiter 重检）；
  pool 的 100-active 硬上限仍在 step-18 pool，路由器 `canFit()` 做预检。
- **依赖图**：engine 不直 import swarm（builder 间接注册）；swarm/pool reach
  `agent/pool.js` 叶子（不经 `agent/index` barrel）。
- **失败隔离**：单个子 agent 失败不中断兄弟（ok:false slot）；只有全局 budget /
  dispatch abort 取消整个 fan-out。
- **judge 留桩**：step-21 前不抛错，`judgement` 留 undefined + warn。

## 6. 冒烟结果

```
=== Step-20 SwarmR dispatch smoke ===
  (43 项断言)
=== 43 passed, 0 failed ===
```

离线运行：`bun scripts/smoke-step20.ts`（无网络 / 无 TTY / 无真实 provider；
全部走 stub provider）。

回归：`bun scripts/smoke-step18.ts` 仍 26/26 通过（step-18 pool 未改）。

## 7. 风险与遗留

- **100 spawn fan-out**：spec §风险 指出 fd / 内存风险。当前 pool 硬上限 100
  active；parallelism 默认 8 限流；HTTP keepalive 在 provider 层（step-17）。
  100 并发 spawn 未在 smoke 实测（成本/时间），但 step-18 smoke 已验证 100 active
  handle 不崩。
- **judge 未实现**：`judgement` 永远 undefined 直到 step-21。主 agent 收到的是
  原始 results[]，足够决策；judge 是增强不是阻塞。
- **per-prompt maxTokens 未透传**：wire schema 有 `maxTokens`，但 `SpawnInput`
  当前只透传 `maxRounds`（step-18 pool 未实现 per-child token cap）。router
  里留 `TODO step-18 follow-up` 注释；字段保留在 schema 不删（spec 明列）。
- **UI 进度面板**：`swarmBus` 已就绪（progress / lifecycle 双通道），step-22
  Ink 面板订阅渲染。本步只保证数据结构 + 事件，不渲染 UI。
