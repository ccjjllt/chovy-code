# Step-27 验收报告 — Context Monitor（SCW 触发器 + 自适应阈值）

> Phase H 第一步。依赖 step-17 PCM（ctx window 单源）+ step-26 CheckpointCoordinator（'token-soft' reason 已就绪）。step-28 rebuild 留作下一步。

## 1. 概要

**完成度**：100% — spec 验收 4 条全过；额外补充 6 条单元/单源/取消语义复验。

| 模块 | 状态 | 主文件 |
|---|---|---|
| 自适应阈值 | ✅ | `src/context/thresholds.ts` |
| Token 估算 | ✅ | `src/context/tokenizer.ts` |
| ContextMonitor 主类 | ✅ | `src/context/monitor.ts` |
| Engine 接线 | ✅ | `src/engine/queryEngine.ts` + `src/engine/contextHook.ts` |
| Prompt `<context-pressure>` 段 | ✅ | `src/prompts/snippets.ts:pressureSection` |
| HeaderBar 实时 ctx % + 颜色 | ✅ | `src/cli/components/HeaderBar.tsx` |
| REPL onContextSnapshot/onUsage 接线 | ✅ | `src/cli/repl.tsx` + `src/agent/runAgent.ts` |
| `CHOVY_CTX_DISABLE` 开关 | ✅ | `src/engine/contextHook.ts:createContextMonitorIfEnabled` |
| `context.threshold` telemetry 单源 | ✅ | `src/context/monitor.ts` 唯一 emit |
| 冒烟 | ✅ | `scripts/smoke-step27.ts` 48 PASS / 0 FAIL |

## 2. 产物清单

### 2.1 新增

```
src/context/
├── tokenizer.ts        (94)   # 4 chars/token × 1.2 安全系数 + 4 token/msg overhead
├── thresholds.ts       (148)  # PCM 单源 ctx window + soft/hard ratio + reserve clip
├── monitor.ts          (300)  # ContextMonitor + 事件订阅 + 上转换边沿检测
└── index.ts            (33)   # barrel：单源 re-export

src/engine/
└── contextHook.ts      (108)  # createContextMonitorIfEnabled + pendingFromMonitorState
                                # （把 SCW 适配从 queryEngine.ts 拆出来保 600 行硬限）

scripts/
└── smoke-step27.ts     (~440)  # 10 节、48 用例（验收 + 单元 + 单源 + 取消）

docs/complete/
└── step-27-acceptance.md      # 本报告
```

### 2.2 修改

| 文件 | 修改 |
|---|---|
| `src/types/context.ts` | 新增 `ContextPressure`（runtime 注入用，runtime-only field） |
| `src/prompts/snippets.ts` | 新增 `pressureSection(p)` + `PressureSnippet` 接口；spec 84–91 行 XML 块 |
| `src/prompts/builders.ts` | `SystemContext.pressure` 可选字段；`joinSections` 末尾插入 pressure 段 |
| `src/prompts/index.ts` | barrel 加 `pressureSection` / `PressureSnippet` 导出 |
| `src/engine/queryEngine.ts` | 注入 `ContextMonitor`；每轮 `inspect()`；`pendingPressure` / `pendingBudget` 透传到下轮 BuildOptions；新增 `onContextSnapshot` 回调 |
| `src/engine/runHelpers.ts` | `fillBuildOptions` 接 pressure/contextBudget；新 `buildSpawnHandles` helper（保 600 行硬限） |
| `src/agent/runAgent.ts` | `AgentOptions` 新增 `onContextSnapshot` + `onUsage` 转发 |
| `src/cli/components/HeaderBar.tsx` | `BudgetSnapshot.pressureLevel` 可选字段；soft=黄、hard=红、bold |
| `src/cli/repl.tsx` | `budget` 改 `useState`；`runAgent` 调用接入 `onContextSnapshot` + `onUsage`（PCM 计价） |
| `src/memory/checkpointWriter.ts` | `getSubAgentPool` 改从 `agent/pool.js`（leaf）导入；解 engine→memory→agent→engine 加载环（AGENTS.md §18 同模式） |
| `src/index.ts` | barrel 增 `export * as context` |

### 2.3 接口冻结（B6 屏障预留 step-28）

| 接口 | 文件 | 位置 |
|---|---|---|
| `ContextLevel = 'fresh'\|'soft'\|'hard'` | `src/context/monitor.ts` | step-27 冻结 |
| `MonitorState` | `src/context/monitor.ts` | step-27 冻结（5 字段：total/effective/thresholds/level/transitioned/checkpointTriggered） |
| `ContextThresholds` | `src/context/thresholds.ts` | step-27 冻结（5 字段，含派生 `effectiveWindow`） |
| `ContextMonitor` | `src/context/monitor.ts` | step-27 冻结（inspect/onLevelChange/_resetForTesting） |
| `ContextPressure` | `src/types/context.ts` | step-27 冻结（runtime-only） |
| `PressureSnippet` | `src/prompts/snippets.ts` | step-27 冻结（pressureSection 入参） |
| `QueryRunOptions.onContextSnapshot?` | `src/engine/queryEngine.ts` | step-27 追加（§16 frozen-extension） |
| `AgentOptions.onContextSnapshot?` / `onUsage?` | `src/agent/runAgent.ts` | step-27 追加 |
| `BudgetSnapshot.pressureLevel?` | `src/cli/components/HeaderBar.tsx` | step-27 追加（UI-only） |

## 3. spec 验收逐条

### 3.1 模拟长对话 → soft 触发 checkpoint

> spec 验收 §1：模拟长对话 → soft 触发 checkpoint 子 agent

`scripts/smoke-step27.ts §3`：
- 真实 openai 阈值（soft=96 000 tokens），喂入 350k 字符消息（≈ 105k tokens）
- 注入 stub `CheckpointCoordinator` 替身
- 第一次 inspect → `level='soft'` + `transitioned=true` + 调用一次 `coord.maybeCheckpoint('token-soft', ...)` + 一次 `context.threshold` telemetry（`level='soft'`）
- 第二次 inspect 同样数据 → 不再触发（粘性 + per-reason debounce 自然兜底）

7 条用例（3a–3g）全部 PASS。

### 3.2 HeaderBar 数字与实际估算误差 < 5%

> spec 验收 §2：HeaderBar 数字与实际估算误差 < 5%

实现：HeaderBar 直接显示 monitor 的 `state.total / state.thresholds.ctxWindow`，monitor 用同一个 `defaultEstimator` 计算 `total`，因此 *零* 漂移。

`scripts/smoke-step27.ts §2` 验证 estimator 自身的稳定性：
- `countString(1024) === Math.ceil(1024 / 4 * 1.2) === 308` ✓
- `countString(10240) === 3072` ✓
- `countString(65536) === 19661` ✓
- `countMessages` 包含 role + content + tool-call args + 4-token/msg overhead ✓

`pickEstimator(family)` 给后续 tiktoken / Anthropic 计数器留 hook（feature `'exact_count'` off）。

### 3.3 切换 model（不同 ctx 窗口）阈值自动更新

> spec 验收 §3：切换 model（不同 ctx 窗口）阈值自动更新

实现：`thresholds(model, providerId, cfg, env)` 直接读 `CAPS[providerId].contextWindow`（PCM 单源）。每轮新 monitor 实例自动 pick 当下 provider/model 的 ctx 窗口。

`scripts/smoke-step27.ts §1+§4`：
- openai → 128 000 / soft 96 000 / hard 115 200 ✓
- gemini → 1 000 000 / soft 750 000 ✓
- 切 monitor 实例 → 阈值随 provider 自动更新 ✓
- env override `CHOVY_CTX_SOFT_RATIO=0.6` → soft=floor(128000*0.6)=76800 ✓
- 非法 ratio（soft>=hard）→ `logger.warn` + 回退 cfg 默认 ✓

### 3.4 关闭 monitor（CHOVY_CTX_DISABLE=1）时 QueryEngine 仍正常运行

> spec 验收 §4：关闭 monitor 时 QueryEngine 仍正常运行（只是不再自动 checkpoint）

实现：`createContextMonitorIfEnabled(deps)` 检查 `process.env.CHOVY_CTX_DISABLE === '1'` → 返回 `null`；queryEngine 主循环 `if (ctxMonitor) { ... }` 守卫，无 monitor 时跳过 inspect / 不发 telemetry / 不触发 checkpoint，正常继续运行。

`scripts/smoke-step27.ts §5`：
- env=1 → factory 返回 null ✓
- env 复位 → factory 返回 instance ✓
- engine 主循环 不依赖 monitor 存在（守卫 `if (ctxMonitor)`）

### 3.5 风险：估算误差导致 hard 早触发 → reserve 默认偏保守

> spec §风险：估算误差导致 hard 早触发 → reserve 默认偏保守（4k）

实现：
- `ESTIMATE_SAFETY = 1.2`：估算偏向 *高估* 输入 token，hard 早触发好过晚触发
- `cfg.context.reserveTokens` 默认 2048（cc-haha 的 4k 的一半，对齐 chovy-code config schema）；可由 `CHOVY_CTX_RESERVE_TOKENS` 覆盖
- `effectiveWindow = ctxWindow - reserve`；reserve clipped at 50% ctxWindow（防 user 设值过大）

## 4. 单源 / 不变量复验

### 4.1 `context.threshold` telemetry 单源

`grep -rn "context.threshold" src/` → 唯一 emit 点 = `src/context/monitor.ts:emitTelemetry`（在 `inspect()` 内的 transition 分支）。queryEngine / coordinator / REPL / HeaderBar 全部为消费方，零额外 emit。

### 4.2 `level: 'soft' | 'hard'`，fresh 不发

union 已在 `src/telemetry/events.ts` 冻结为 `'soft' | 'hard'`；monitor `inspect()` 在 `if (next !== "fresh")` 守卫下才发 telemetry。`scripts/smoke-step27.ts §6` 严格断言 levels 数组不含 `'fresh'`。

### 4.3 单向上转换（sticky max-level）

`isUpwardTransition(prev, next)` 用 `{fresh:0, soft:1, hard:2}` 数值序判定。下转换（hard→soft、soft→fresh）不触发 telemetry / checkpoint，避免临时消息裁剪导致 soft 反复 fire。step-28 rebuild 后由 monitor 重置或新建实例处理。

### 4.4 取消独立 AC（AGENTS.md §9）

monitor 持 `parentSignal` 仅 *观察*；`maybeCheckpoint` 触发用 fire-and-forget `void coord.maybeCheckpoint(...)`，coordinator 内部本地 AC 包装 parentSignal（与 step-26 §11 不变量一致）。`scripts/smoke-step27.ts §7`：pre-aborted parentSignal → `inspect()` 同步返回 state，不抛。

### 4.5 队列加载环已闭合

step-26 引入 queryEngine.ts → memory/checkpointWriter.ts 链；checkpointWriter 之前从 `agent/index.ts` barrel import → 触发 `runAgent.ts` 顶层 `setSpawnFnBuilder(...)` → TDZ on registry。本步改为 `from "../agent/pool.js"`（leaf），与 AGENTS.md §18 `swarm/pool → agent/pool` 同模式。冒烟回归 smoke-step23（36）/24（50）/26（50）全部 PASS。

### 4.6 queryEngine.ts ≤ 600 行

当前 600 行（恰至硬限）。SCW 适配独立到 `src/engine/contextHook.ts`（108 行），spawn/dispatch handle 构造独立到 `runHelpers.ts:buildSpawnHandles`。后续 step-28 rebuild 接入时继续抽 helper，不要把逻辑塞回 queryEngine.ts。

## 5. 冒烟与回归

| 冒烟 | 用例数 | 结果 |
|---|---|---|
| `bun scripts/smoke-step27.ts` | 48 | ✅ 0 FAIL |
| `bun scripts/smoke-step26.ts`（回归） | 50 | ✅ 0 FAIL |
| `bun scripts/smoke-step24.ts`（回归） | 50 | ✅ 0 FAIL |
| `bun scripts/smoke-step23.ts`（回归） | 36 | ✅ 0 FAIL |
| **合计** | **184** | **184 PASS / 0 FAIL** |

构建：`bun run typecheck` 0 error；`bun run build` 成功（823 KB bundle）；`bun bin/chovy.js --version` → `0.1.0`。

## 6. spec 与实现差异

### 6.1 hard 不在 step-27 自我 rebuild

spec 写 `hard → 进入 step-28 的 rebuild 流程`。本步 monitor 仅做：
- 打 `context.threshold` telemetry（level='hard'）
- 注入更紧迫的 `<context-pressure level="hard">` block
- 触发 `coord.maybeCheckpoint('token-soft')`（30s per-reason debounce 自然兜底）
- `logger.warn` 一次表明 rebuild pending

不做：
- 主循环早退（rebuild 由 step-28 控制）
- 切换 reason 为 `'token-hard'`（step-26 union 当前不含；新增成员是 step-26 的事）

### 6.2 `MIN_SOFT_RATIO = 0.5` 防御性下限

cc-haha autoCompact 没有这个下限；chovy-code 加上是为了：
- 防 user 误把 ratio 设成 `0.05` 之类导致每轮都 fire soft
- 测试时可绕过（smoke-step27 用真实 openai 阈值 + 大字符串，而不是降低 ratio）

如未来出现合法低 ratio 用例，可放宽下限到 0.1 或加 `CHOVY_CTX_ALLOW_LOW_RATIO=1` 后门。

## 7. 依赖图（更新）

```
src/context/* ─┬─→ src/types/messages.ts (ChatMessage)
               ├─→ src/types/provider.ts (ProviderId)
               ├─→ src/types/agent.ts (AgentRole)
               ├─→ src/types/goal.ts (GoalHistoryEntry)
               ├─→ src/types/context.ts (ContextPressure 类型)
               ├─→ src/providers/capabilities.ts (CAPS, ProviderFamily)
               ├─→ src/config/config.ts (ChovyConfig)
               ├─→ src/logger/index.ts
               ├─→ src/telemetry/index.ts
               └─→ src/memory/checkpointWriter.ts (类型 + CheckpointCoordinator)

src/engine/contextHook.ts ─→ src/context/index.ts
                          ─→ src/prompts/index.ts (PressureSnippet 类型)

src/engine/queryEngine.ts ─→ src/engine/contextHook.ts
                          ─→ src/memory/checkpointWriter.ts (getCheckpointCoordinator)
                          ─→ src/context/index.ts (类型)

src/memory/checkpointWriter.ts ─→ src/agent/pool.ts (leaf, 不经 barrel)
                                                 ↑ 本步关键改动：解 engine→memory→agent→engine 环
```

无环。`src/context/*` 是叶子模块，被 engine/contextHook + 未来 step-28 rebuilder + step-29 SCG 引用，不反向被 engine/providers/agent/swarm/goals 依赖（与 §20 memory 单源同模式）。

## 8. 下一步衔接（step-28 / step-29）

### 8.1 step-28 — Context Rebuild

step-27 留好的接驳：
- `MonitorState.level === 'hard'` 时 queryEngine 已 `logger.warn`，rebuild 接入只需在该分支替换为：
  - 调用 step-28 `rebuildContext(messages, monitor.thresholds, ...)`：根据 `ContextBudget` 预算化注入 memory + checkpoint + tail
  - 把 messages 数组替换为 rebuilt 版本
  - `monitor._resetForTesting()` 或新建 monitor 实例（让 level 回到 fresh）
- `ContextBudget` 类型已在 `src/types/context.ts` 冻结（5 bucket：memory/checkpoint/notes/skills/tail）；step-28 实现 `rebuildContext` 时直接消费

### 8.2 step-29 — Conditional Skill Graph

monitor 的 `MonitorState.transitioned` + `level` 边沿事件可作 SCG planner 的预算输入信号：
- `level==='soft'` → SCG 自动卸载非必需 skill 节点
- `level==='hard'` → SCG 仅保留 critical skills（per-budget）

step-29 设计时直接订阅 `monitor.onLevelChange(cb)`。

---

**结论**：step-27 完整交付，184 用例全过；4 项 spec 验收全过；queryEngine.ts 维持 ≤ 600 行硬限；`context.threshold` telemetry 单源；引入了对 step-28/29 的清晰 hook，不破坏屏障接口。可继续 step-28（Context Rebuild）。
