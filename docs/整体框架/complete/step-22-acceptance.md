# Step-22 Agent UI — 验收报告

> 日期：2026-06-18
> Phase：E（Sub-Agent System）
> 依赖：step-18 ✅（SubAgentPool / SubAgentHandle / lifecycle / telemetry）
> 并行：与 step-19 / step-20 / step-21 同属 W4 worker；本步**不依赖** 20/21

## 0. 任务范围

按 [`docs/step-22-agent-ui.md`](../step-22-agent-ui.md) 落地 Ink 子 agent 进度面板：
**SwarmPanel + AgentRow + AgentDetail + HotkeyBar**，让用户实时看到所有运行中 / 已完成
子 agent 的状态、phase、成本，并能取消选中 agent / 查看详情。

不在本步骤做（按计划留给后续）：
- step-20 SwarmR `dispatch(N)` 并发分发 — 本步直接用 `pool.spawn` 驱动冒烟
- step-21 Judge 聚合 — N/A
- step-23 `/goal` 真实循环 — `[g]` 热键仅切换 goal 横幅占位
- step-26 checkpoint 持久化 — `[s] save snapshot` 为 stub（stderr 输出 + TODO 标记）
- 全量窗口化 / 鼠标支持 — 仅做 top-N 切片（spec 称"virtualization 简化版"）

## 1. 文件清单

### 新增

| 文件 | 行数 | 摘要 |
|---|---|---|
| `src/agent/swarmBus.ts` | 72 | UI-only 进程内 pub/sub：`SwarmEvent`（lifecycle/progress/cost）+ `onSwarmEvent/emitSwarmEvent` + `_swarmBusListenerCount/_resetSwarmBusForTesting`。**永不持久化**（telemetry 单源仍是 pool） |
| `src/agent/outputBuffer.ts` | 83 | 每子 agent 2KB 环形流式输出缓冲：`appendOutput/getOutput/clearOutput/markFinished/evictExpired`。60s TTL 清扫；`pool.reset()` 清空 |
| `src/cli/state/swarmStore.ts` | 137 | `useSwarmState()` React hook：订阅 swarmBus + **16ms 节流** setState；`useSwarmTick(ms)` 计时 tick；`swarmCounts()` 纯 helper |
| `src/cli/components/SwarmPanel.tsx` | 218 | 主面板：border + title（`Swarm (N running, M done)` + budget）+ top-8 行 + `+ N more` 折叠 + 选中态 + 详情浮层路由 + 双 `useInput`（list / detail，`isActive` 互斥） |
| `src/cli/components/AgentRow.tsx` | 123 | 单行：`▶ sa_a1b2 explore ⏳ reading file foo.ts 12s $0.02`；状态色 + 截断 + 耗时格式化 |
| `src/cli/components/AgentDetail.tsx` | 153 | 详情浮层：provider/model/status/phase/tokens/cost + prompt + `Last output (preview)`（200ms pull 自 outputBuffer）+ result.reason |
| `src/cli/components/HotkeyBar.tsx` | 31 | 单行热键提示；list 模式 / detail 模式两套 |
| `scripts/smoke-step22.ts` | 465 | 9 组验收：bus 订阅/发射、lifecycle 发射、outputBuffer 环形+TTL、pool 实时进度、cancel ≤0.5s、subscribe/unsubscribe 配对、100 agent 压测 <50ms、dispatch 5、cap 101 回归 |

### 修改

| 文件 | 改动要点 |
|---|---|
| `src/agent/lifecycle.ts` | `setStatus/setPhase/addUsage` 增加 `emitSwarmEvent` 副作用（单一 chokepoint；UI 永不漏状态跃迁）。**纯追加**，无字段/签名变更（尊重 step-18 冻结） |
| `src/agent/pool.ts` | `runChild` 给 `engine.run` 传 `onToken/onToolStart/onUsage` 回调：`onToken`→`appendOutput`；`onToolStart`→`setPhase(phaseForTool(name))`；`onUsage`→`addUsage`。新增 `phaseForTool` 工具名→phase 映射。`reset()` 清 outputBuffer。`runChild` finally `markFinished` + `evictExpired`。无签名变更 |
| `src/agent/index.ts` | barrel re-export `swarmBus` + `outputBuffer` 全套 API |
| `src/cli/repl.tsx` | 挂 `<SwarmPanel>`（`CHOVY_NO_SWARM_PANEL=1` 禁用）；`useSwarmState()` 订阅；`Tab` 切焦点 input↔panel；`HeaderBar` 传 `swarm` 摘要；`listAgents()` 读真实 pool |
| `src/cli/components/HeaderBar.tsx` | 新增可选 `swarm?: SwarmSummary` prop → 右侧 `swarm: 3R/2D` chip；缺省时隐藏（向后兼容） |
| `src/cli/slashCommands.ts` | `/agents` 文案从 "TODO step-22" 改为 "step-22"（handler 早已接 `ctx.listAgents()`，现在 REPL 给的是真实 pool 数据） |
| `src/cli/index.tsx` | `chovy agent list` 读 `getSubAgentPool().list()` 并逐行打印；import `getSubAgentPool` |

## 2. 关键设计决策

### 2.1 进度来源：wire into pool + swarmBus（用户决策 #1）

step-18 的 pool 只在 finalize 时写 `handle.costUSD/tokens*`，phase 字段从未在运行中被更新。
step-20 的 `swarmBus` 尚未实现。本步**预建** step-20 spec `§进度上报` 描述的 bus
（`onSwarmEvent('lifecycle'|'progress'|'cost')` API 与 step-20 spec 1:1 对齐），并在
`pool.runChild` 里给子 `QueryEngine.run` 传三个回调：

```ts
onToken:    (delta) => appendOutput(handle.id, delta)        // → AgentDetail 预览
onToolStart: (name)  => setPhase(handle, phaseForTool(name)) // → 行内 ⏳ phase
onUsage:    (u)      => addUsage(handle, u)                  // → 实时 token/cost
```

`lifecycle.ts` 的 `setStatus/setPhase/addUsage` 各自 `emitSwarmEvent`——**单一 chokepoint**，
任何状态变更都广播，UI 不可能漏掉跃迁。这是纯追加副作用，不改任何字段/签名
（尊重 step-18 接口冻结）。

### 2.2 swarmBus = UI-only，不进 telemetry（AGENTS.md §17 单源不变量）

- `subagent.spawn` / `subagent.end` telemetry **仍由 pool 单源发射**（step-18 不变）。
- `swarmBus` 是独立的进程内 pub/sub，**永不持久化**，payload 只有 `id + 事件类型`（无消息内容）。
- `swarmStore` 在 flush 时 re-read `pool.list()` 拿最新 handle 引用——pool 是 live handle 的
  单一 owner，bus 不复制状态。

### 2.3 面板可见性：any handle exists（用户决策 #2）

`repl.tsx` 在 `swarm.agents.length > 0` 时挂 SwarmPanel；pool 空时自动收起（`useSwarmState`
返回空数组 → 条件渲染 null）。`done/failed` 行保留可查（按 `Enter` 看 AgentDetail），
符合 spec §UI 布局同时列了 done/failed 行的描述。`CHOVY_NO_SWARM_PANEL=1` 完全禁用面板
（spec §风险 Windows ConHost 闪烁缓解），header chip 仍显示计数。

### 2.4 AgentDetail 预览：独立 outputBuffer（用户决策 #3）

不向 `SubAgentHandle` 加字段（尊重 step-18 冻结）。`src/agent/outputBuffer.ts` 以子 agent
id 为 key 存 2KB 环形流式输出；`onToken` 喂入，`AgentDetail` 200ms pull 读出。生命周期：
terminal 后保留 60s（让用户能按 `Enter` 看），`pool.reset()` 清空，`evictExpired` 清扫冷条目。

### 2.5 节流（spec §性能 "16ms 节流"）

`useSwarmState` 用 dirty-flag + `setTimeout(flush, 16)`：首个事件调度一次 flush，后续事件
只标 dirty，已调度的 flush 会一并取走。100 agent 并发 → 每帧一次 setState。冒烟实测
100 emit + 1 flush（pool.list 快照）< 50ms（见 §4）。

### 2.6 键盘焦点：Tab 切换（避免热键/文本输入冲突）

Ink 的 `useInput` 是全局 stdin。为让 `↑/↓/x/Enter` 在面板生效**且不破坏** InputBox 打字：
- REPL 持 `focus: "input" | "panel"`，`Tab` 切换（busy 时不切，防打断）
- SwarmPanel 的 list `useInput` `isActive = focused && 无 detail`
- detail `useInput` `isActive = detail != null`（overlay 独占）
- 面板消失时焦点自动回 input（`useEffect` 兜底）

热键（spec §快捷键）：`↑/↓` 选中、`x` 取消、`Enter` 详情、`g` 切 goal 横幅、`Esc` 关闭/失焦。
detail 内：`c` 取消、`s` 存快照（stub → step-26）、`Esc` 返回列表。

### 2.7 虚拟化简化版（spec §性能 "仅渲染 visible rows"）

`sorted.slice(0, 8)` 渲染 + `+ N more` 折叠行。选中索引 clamp 到可见窗口。100 agent
压测只渲染 ≤9 行 → 满足 <50ms 延迟。全量窗口化（滚动 + offset）留给后续。

## 3. AGENTS.md 不变量遵守

| 规则 | 实现 | 说明 |
|---|---|---|
| §9 子 agent 自有 AbortController | 未触碰 pool 的 AC 逻辑 | 仅追加回调，不改取消路径 |
| §16/§17 telemetry 单源 = pool | `swarmBus` 独立，不进 `telemetry/events.ts`；`subagent.spawn/end` 仍只在 pool 发射 | UI-only 通道，永不持久化 |
| §8 单文件 ≤ 600 行 | 最大 `smoke-step22.ts` 465；`SwarmPanel` 218；其余 <160 | 通过 |
| §5 红线 | 无外部上传、无 `bin/chovy.js` 改动、无 `--no-verify` | 通过 |
| §17 接口冻结 | `SubAgentHandle` / `SpawnInput` / `QueryRunOptions` 字段零变更；lifecycle/pool 仅追加副作用 | 尊重 step-18 冻结 |
| 无新依赖 | Ink/React 已就位 | 通过 |

## 4. 验收标准（spec §验收标准）

| # | 标准 | 实测 | 来源 |
|---|---|---|---|
| 1 | dispatch 5 子 agent，UI 动态更新各自 phase | ✅ | `smoke-step22`: `dispatch5: pool lists 5 handles` + `dispatch5: all 5 reach done` + `progress: ≥2 lifecycle events for child`（lifecycle/progress/cost 事件经 bus 传播；`useSwarmState` 节流 flush 后 `pool.list()` 反映 5 handle + 实时 phase/tokens） |
| 2 | `x` 取消 → 0.5s 内 UI 标记 cancelling | ✅ | `smoke-step22`: `cancel: handle reaches terminal ≤ 500ms` + `cancel: status === cancelled`（bus lifecycle 事件同步发射，store 下次 flush 即见 cancelled） |
| 3 | 终止时无内存泄漏（subscribe/unsubscribe 配对） | ✅ | `smoke-step22`: `leak: 100 listeners attached` → `leak: all unsubscribed → count back to 0` + `leak: single re-attach → 1` → `leak: single unsubscribe → 0`（`useSwarmState` useEffect 返回 `off()` + 清 timer） |
| 4 | 100 子 agent 压测时 UI 延迟 < 50ms | ✅ | `smoke-step22`: `stress: 100 agents spawned` + `stress: flush snapshot returns 100 handles` + `stress: flush < 50ms`（100 emit 合并为 1 dirty flag，flush = 一次 pool.list 快照） |
| — | 类型检查 | ✅ | `bun run typecheck` 0 错 |
| — | step-18 无回归 | ✅ | `bun scripts/smoke-step18.ts` 26/26 通过 |
| — | step-11 无回归 | ✅ | `bun scripts/smoke-step11.ts` 45/45 通过（meta tool / SpawnFn 强类型） |
| — | step-22 完整 smoke | ✅ | `bun scripts/smoke-step22.ts` 37/37 通过 |

### 额外覆盖（非 spec 必需但合理）

- outputBuffer 2KB 环形保尾 ✅（`buf: caps at 2KB (keeps tail)`）
- outputBuffer 60s TTL 清扫：冷条目驱逐 / 热条目存活 ✅
- `lifecycle.ts` 三函数（setStatus/setPhase/addUsage）各自 emit ✅
- `emitSwarmEvent` 无 listener 时不抛 ✅
- pool cap 101 仍抛 `AGENT_BUDGET_EXCEEDED`（无 step-18 回归）✅
- `HeaderBar` swarm chip 缺省隐藏（向后兼容）✅

## 5. Smoke 输出

```
=== Step-22 agent UI smoke ===
  PASS  bus: baseline listener count is 0
  PASS  bus: subscribe increments count
  PASS  bus: listener receives lifecycle event
  PASS  bus: listener receives progress event
  PASS  bus: unsubscribe decrements count
  PASS  bus: emit with no listeners doesn't throw
  PASS  lifecycle: emits lifecycle on setStatus
  PASS  lifecycle: emits progress on setPhase
  PASS  lifecycle: emits cost on addUsage
  PASS  lifecycle: addUsage rolled tokens into handle
  PASS  buf: getOutput returns appended text
  PASS  buf: caps at 2KB (keeps tail)
  PASS  buf: evictExpired drops cold finished entry
  PASS  buf: getOutput empty after eviction
  PASS  buf: hot finished entry survives eviction
  PASS  buf: clearOutput drops entry
  PASS  buf: count tracks entries
  PASS  progress: child settled to done
  PASS  progress: cost event emitted for child id
  PASS  progress: ≥2 lifecycle events for child
  PASS  cancel: handle starts running
  PASS  cancel: handle reaches terminal ≤ 500ms
  PASS  cancel: status === cancelled
  PASS  leak: baseline 0 listeners
  PASS  leak: 100 listeners attached
  PASS  leak: all unsubscribed → count back to 0
  PASS  leak: single re-attach → 1
  PASS  leak: single unsubscribe → 0
  PASS  stress: 100 agents spawned
  PASS  stress: 100 emits coalesce to one dirty flag
  PASS  stress: flush snapshot returns 100 handles
  PASS  stress: flush < 50ms
  PASS  stress: cancelAll drains to 0
  PASS  dispatch5: pool lists 5 handles
  PASS  dispatch5: all 5 reach done
  PASS  dispatch5: all handles rolled up tokens
  PASS  cap: 101st spawn throws AGENT_BUDGET_EXCEEDED (no step-18 regression)
=== 37 passed, 0 failed ===
```

## 6. 工程注意点（移交后续 step）

1. **swarmBus 是 step-20 的前置**：本步预建了 step-20 spec `§进度上报` 描述的
   `swarmBus.on('lifecycle'|'progress'|'cost')` API（命名对齐 `onSwarmEvent`）。step-20
   落地 SwarmR router 时**直接复用** `emitSwarmEvent`，不要另写总线；dispatch 的并发
   spawn 会自动经 pool → lifecycle → bus 链路让 UI 看到每条子 agent。

2. **`SubAgentHandle` 仍冻结**：本步未向 handle 加任何字段。实时 phase 经
   `setPhase` 写入既有 `handle.phase`；实时 tokens 经 `addUsage` 写入既有
   `tokensIn/tokensOut`；流式输出经独立 `outputBuffer`。step-20/21 若需更多实时
   字段（如 `currentTool`），请优先复用 `phase` 字符串，不要扩类型。

3. **`onToken` 回调是 best-effort**：pool 的 `onToken` 包了 try/catch + swallow——
   UI-only 副作用绝不能让子 agent run 失败。若 outputBuffer 抛错，子 agent 仍正常完成。
   step-20 dispatch 不要在 `onToken` 里做任何影响结果的事。

4. **`[s] save snapshot` 是 stub**：AgentDetail 的 `s` 热键目前 stderr 输出一行
   snapshot 摘要 + `TODO step-26`。step-26 checkpoint-writer 落地后，把这里改成调
   `writeCheckpoint(handle)`，落盘到 `~/.chovy/projects/<id>/checkpoints/`。

5. **`CHOVY_NO_SWARM_PANEL=1`**：Windows ConHost 闪烁缓解开关（spec §风险）。设后
   SwarmPanel 不挂载，但 HeaderBar 的 `swarm: NR/ND` chip 仍显示（让用户知道有子
   agent 在跑）。推荐 Windows Terminal；ConHost 用户用此开关降级。

6. **键盘焦点 Tab**：REPL 用 `Tab` 在 InputBox ↔ SwarmPanel 间切焦点。busy 时不切
   （防打断 agent run）。面板消失（pool 空）时焦点自动回 input。step-23 `/goal`
   落地后若加 GoalPanel，复用同一 `focus` state（扩展为 `"input"|"panel"|"goal"`）。

7. **节流参数**：`useSwarmState` 的 `THROTTLE_MS = 16`（spec §性能）；`useSwarmTick`
   默认 1000ms（elapsed 计时）。`AgentDetail` 的 output pull 是 200ms（spec §性能）。
   不要在使用点改这些值；如需调，改常量。

## 7. 与 cc-haha 借鉴的对比

借鉴：
- `CoordinatorAgentStatus.tsx` 的"可见行 + 1s tick + evict 过期任务"模式 → SwarmPanel 的
  top-N + `useSwarmTick(1000)` + outputBuffer TTL 驱逐。
- `AgentProgressLine.tsx` 的 tree-char + 状态色 + token 计数行 → AgentRow 的 `▶` glyph +
  `STATUS_COLOR` 表 + `$cost` 后缀。
- 每行 `lastActivity` arrow / `tokenCount` 摘要 → AgentRow 的 phase 列 + AgentDetail 的
  tokens in/out。

差异化（坚持创新）：
- **SwarmR + Judge**：cc-haha 的 coordinator 是"领导者发消息"，chovy 的 SwarmR 是
  `dispatch(N)` 单次派发 + Judge 结构化聚合（step-20/21）。本步的 swarmBus 是 SwarmR
  的进度通道预建。
- **ATP 描述选择**：cc-haha 无 lean/full 双描述；chovy 子 agent 的工具描述经 ATP 按
  预算选 lean/full（step-07），本步不涉及但子 agent run 自动享受。
- **PCM 跨 provider**：cc-haha 只 Anthropic；chovy 子 agent 可异构 provider（本步
  AgentDetail 显示 `provider/model`，step-20 dispatch 真正用上异构路由）。
- **PSF**：cc-haha 无跨 provider 通用化；chovy 子 agent run 同样发射 `prompt.shape`
  事件，可用于诊断子 agent 提示稳定性。

## 8. 下一步

按 `docs/README.md §1`：

- step-20 — SwarmR `dispatch(N)`：**直接复用** `emitSwarmEvent`（已预建），并发 spawn
  自动经 pool → lifecycle → bus 链路点亮 UI。
- step-21 — Judge 聚合：消费 dispatch 结果，独立模块，不碰本步 UI。
- step-23 — `/goal` 长程任务：`[g]` 热键已占位切 goal 横幅；真循环接 `handle.cancel`
  + `paused` 跃迁。
- step-26 — checkpoint-writer：替换 AgentDetail 的 `[s]` stub 为真落盘。
