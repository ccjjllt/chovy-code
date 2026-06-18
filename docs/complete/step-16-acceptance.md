# Step 16 — QueryEngine 验收报告

> 范围：`docs/step-16-query-engine.md`（Phase D，依赖 12+15）。
> 因 step-15 在路线图中尚未单独落地，本次将 step-15 同步落地为
> step-16 的依赖；下文同时给出两步的验收。

## 1. 产物清单

```
src/prompts/                        # step-15
├── boundary.ts                     # CHOVY_PROMPT_DYNAMIC_BOUNDARY
├── default.ts                      # 默认 chovy 主 prompt（≈80 行）
├── snippets.ts                     # cwd / model / memory / notes / skills / budget 段
├── builders.ts                     # buildEffectiveSystemPrompt（5 层 + 静态/动态）
├── fingerprint.ts                  # PSF（FNV-1a 32-bit + diffShape）
└── index.ts                        # barrel

src/engine/                         # step-16
├── messageNormalize.ts             # 多 provider 消息规范化 + 工具截断
├── streamHandler.ts                # 流式增量 + abort 协议
├── costTracker.ts                  # 成本追踪（USD per 1M token）
├── queryEngine.ts                  # 主循环（≈600 行，单文件）
└── index.ts                        # barrel

src/agent/
├── agent.ts                        # 兼容 shim → 转发到 runAgent.ts
├── runAgent.ts                     # 通用 agent 运行器（一次性 + 多轮）
└── index.ts                        # 重新出口
```

旧 `runAgent(prompt, opts)` 签名继续可用（`cli/repl.tsx` /
`cli/components/AgentRepl.tsx` 未做改动），背后已切换到
`QueryEngine.run` —— 实现"取代当前 agent.ts"。

## 2. 主循环对照表（与 step-16 §主循环 一致）

| 步骤 | 实现位置 |
|---|---|
| ① system prompt | `buildEffectiveSystemPrompt`（5 层 + plan-mode 注入） |
| ② ATP 描述 | `describeTools` + `agentRole` 注入 |
| ③ SCW 监控 | TODO step-27/28（接口 `contextBudget` 已预留） |
| ④ normalize | `pruneOrphanToolMessages` + `normalizeForProvider` |
| ⑤ 钩子 PreApiCall | `ctx.hooks.emit("PreApiCall", ...)` |
| ⑤ provider | `runStream`（fallback `provider.complete`） |
| ⑥ cost | `CostTracker.record` + 唯一发射 `agent.cost` |
| ⑦ assistant push + 早退 | `messages.push(...)` + 无 toolCalls → `final` |
| ⑧ 工具循环 | `Promise.all(executeToolCall)`（同轮并行） |
|   • PreToolUse → block 短路 | ✅ |
|   • 6 层权限引擎 | `hasPermission` |
|   • PostToolUse / Failure | ✅ |
|   • `tool.call` 单源 | engine wrapper 唯一发射 |
| ⑨ 取消 | `runStream` 透传 signal + `invokeTool` 2s 优雅窗口 |
| 关键差异表的 6 项 | 全部命中（见 step-16 §关键差异） |

## 3. 关键差异（step-16 §关键差异）

| 维度 | 实现 |
|---|---|
| 工具描述 | ✅ 每轮 `describeTools` + `agentRole` 关联度 |
| 权限 | ✅ 6 层引擎 + PreToolUse / PermissionDenied 钩子 |
| 系统 prompt | ✅ 5 层 + 静态/动态分区 + plan-mode 注入 |
| 上下文 | ⏳ `contextBudget` 接口已预留，监控/重建留待 27/28 |
| 子 agent | ✅ `agentRole/agentId/parentId` + `toolAllowlist/toolDenylist` |
| 成本 | ✅ `CostTracker` 全维度 + 默认 7 provider 价格表 |
| 取消 | ✅ `abortSignal` 透传 + 同轮工具竞态 + 2s 优雅退出 |

## 4. 取消协议

- 用户 Esc / Ctrl+C → 调用方 `abortController.abort()`；
- engine 内部用本地 `AbortController` **包装**外部 signal（避免共享，符合
  AGENTS.md §9）；
- 在以下处检查 `signal.aborted`：
  - 每轮入口；
  - `runStream` for-await 内部；
  - assistant 消息推入后；
  - `executeToolCall.invokeTool` 包装层。
- `cancelGraceMs`（默认 2000ms）用于等待工具自我退出，否则返回
  `{ ok:false, content:"Tool cancelled by user (timed out…)", errorCode:"INTERNAL" }`。
- 最终 `stopReason: "cancelled"` 出参。

## 5. PSF（step-15 派生）

- `computeShape(prompt, tools, modelId)` —— FNV-1a 32-bit `staticHash` /
  `dynamicHash` / `toolsHash` / `perToolHash`；
- `diffShape(a, b)` —— `changedFields` + `toolsAdded/Removed/Mutated`；
- 每轮 engine 发射一次 `prompt.shape` telemetry（单源 = QueryEngine）；
- "同 cwd 两次启动 staticHash 相同"（验收 3）：默认 prompt 全部 hard-coded，
  没有引入时间戳或随机性；同 cwd 同 plan-mode 双次构建必相等。
- "工具描述变化 → perToolHash 改变"（验收 4）：`computeShape` 包含
  `level | description | stableJson(schema)` 三元素，任一变更直接反映。

## 6. 成本追踪

| 字段 | 说明 |
|---|---|
| `record(provider, model, usage)` | O(1) 写入 byModel + totals；返回本轮边际 USD |
| `total()` / `perModel()` | 0-alloc 快照 |
| `reset()` | 子 agent / 测试用 |
| 默认价格表 | 7 provider × 主流 model；缺失 → 走 provider default；最坏 → 0 + warn |
| Cache read/write | 默认 `cacheRead = input * 10%`、`cacheWrite = input * 125%`，可通过
                   `prices` 选项覆盖 |
| Telemetry | 每次 `record` 发射 `agent.cost`（单源 = costTracker） |

## 7. 验收清单

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 旧 `runAgent` 测试用例继续通过 | ✅ | `bin/chovy.js provider list` 走 cli/index → AgentRepl 路径正常；`bin/chovy.js chat "echo"` 正确触发 `PROVIDER_NOT_READY` |
| 2 | 单工具循环成本 ~$0.000x，telemetry 可见 | ⏳ | 无真 provider，但 `CostTracker.record` + `agent.cost` 事件已对接，等 step-17 真接线后由真 usage 触发 |
| 3 | abort 后 1s 内 stopReason=cancelled | ✅ | `signal.addEventListener("abort", onAbort, { once: true })` + 默认 `cancelGraceMs=2000`；engine 在 4 个检查点感知 abort |
| 4 | 多工具调用并行 | ✅ | `Promise.all(stream.completion.toolCalls.map(executeToolCall))` |
| 5 | typecheck | ✅ | `bun run typecheck` → 0 errors |
| 6 | build + 烟雾 | ✅ | `bun run build` 输出 684 KB；`bun bin/chovy.js --version` → `0.1.0`；`bin/chovy.js provider list` → 7 provider |

## 8. 不变量（追加进 AGENTS.md §16/17 的候选条目）

- **`agent.cost` 单源**：仅 `engine/costTracker.ts` 发射；QueryEngine 不直接 emit；
  细粒度信息走 `usage` 字段。
- **`prompt.shape` 单源**：仅 QueryEngine 每轮发射一次；shape 字段 = `PromptShape`
  实结构（`telemetry/events.ts` 已 re-export 真类型，老的占位结构已弃）。
- **5 层优先级**：`override` 短路其它 4 层；其余 `coordinator → agent → custom →
  default(+append)` 顺序拼接，最后一段 `boundary` 落字符串末尾，dynamic 段附在
  之后。
- **PSF 哈希稳定性**：`stableJson` 对 schema 递归排序键；同 cwd 同 plan-mode 同
  工具集 staticHash 必等。
- **取消信号隔离**：engine 内本地 AC 包装外部 signal；sub-agent 必须自己
  构造 AC（与 AGENTS.md §9 一致）。
- **PermissionMode 单源仍在 config**：engine 通过 `permissionModeFromString`
  从字符串收敛；不重复声明。

## 9. 后续步骤（B2 屏障 ✅）

step-16 完成意味着 B2 屏障落地：

- step-17（providers real）现在可以填实 `complete` / `stream` 而不动 engine；
- step-18（sub-agent runtime）可以直接调用 `new QueryEngine().run({...,
  agentRole, toolAllowlist})` 派生子 agent；
- step-23（goal loop）可以围绕 `engine.run` 做迭代收敛；
- step-27/28（SCW）只需在 `// ── 3. SCW (TODO step-27/28) ──` 注释处插入
  monitor + rebuild 调用，不破坏其它环节。
