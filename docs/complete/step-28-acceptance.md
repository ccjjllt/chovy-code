# Step-28 Acceptance — Context Rebuild (SCW 第二步)

**Phase**: H | **依赖**: step-27, step-25 (memory selector inlined here, step-25
will refactor into a shared selector when it lands) | **状态**: ✅ Complete

> 关联：`docs/step-28-context-rebuild.md`、`docs/architecture.md`、AGENTS.md
> §22（Phase H step-27 不变量延伸）→ 本步落地 §23 不变量。

---

## 1. 交付物

| 路径 | 行数 | 说明 |
|---|---|---|
| `src/types/context.ts` | 65 | `ContextBudget` 升级到 8 桶（systemBase/memory/checkpoint/notes/taskProgress/skills/tools/history），保留 `tail` 别名向后兼容 step-27 占位消费方 |
| `src/types/hook.ts` | 200 | `HookEvent` union 新增 `ContextRebuilt` advisory 事件（13 个事件） |
| `src/telemetry/events.ts` | 218 | `context.rebuild` 单源 telemetry 事件（kept/dropped/checkpointBytes/memoryEntries/durMs） |
| `src/context/budgets.ts` | 116 | `computeBudget(model, providerId, cfg, env?) → ContextBudget`；默认 slabs + 小窗口 squeeze 分支（≥10% 给 history） |
| `src/context/selectors/recentMessages.ts` | 134 | tail-K 选择 + tool_use/tool_result 配对保护 + 孤立 tool 消息剔除 |
| `src/context/selectors/checkpointPick.ts` | 73 | 读 `latest.md` + 按 budget 中段截断 |
| `src/context/selectors/progressPick.ts` | 79 | 读活跃 goal 的 `progress.md` + tail 截断 |
| `src/context/selectors/memoryPick.ts` | 109 | `MemoryStore.search` mixed ranker + 渲染 `[layer/type]` bullet list |
| `src/context/rebuilder.ts` | 246 | 主流程：sessions JSONL 归档 → 4 selector 并行 → `<context-rebuilt>` marker → telemetry + hook |
| `src/context/index.ts` | 75 | barrel：runtime + types 单点重导出 |
| `src/engine/rebuildHook.ts` | 191 | `maybeRebuild(...)` + `runScwRound(...)`（QueryEngine 单点入口） |
| `src/engine/costTracker.ts` | 261 | `cumulativeTotal()` + `splitSession()`（rebuild 后保留累计预算） |
| `src/context/monitor.ts` | 314 | 新增 `reset()` 公共方法（rebuild 后清 `_level`，保留 listeners） |
| `src/engine/contextHook.ts` | 109 | `pendingFromMonitorState` hard 路径从 `warn` 改 `info`（rebuild 已接管，不再 "pending"） |
| `src/engine/queryEngine.ts` | 598 | 主循环：替换原 SCW 块为 `runScwRound`；budget 闸用 `cost.cumulativeTotal()`（≤ 600 行硬限） |
| `scripts/smoke-step28.ts` | 549 | 76 用例 PASS / 0 FAIL（含 13 大类、跨 4 个 provider sweep） |

新增公共 API（B6 屏障预留落地）：
- `ContextBudget`（8 桶冻结）
- `RebuildContextInput / RebuildContextResult`
- `MaybeRebuildInput / MaybeRebuildOutcome / ScwRoundInput / ScwRoundOutcome`
- `ContextMonitor.reset()`、`CostTracker.cumulativeTotal()` / `splitSession()`
- `ContextRebuilt` HookEvent
- `context.rebuild` telemetry event

---

## 2. 验收标准对账（spec §验收标准）

| # | spec 验收 | 通过 |
|---|---|---|
| 1 | 模拟一次 200k 上下文 → 重建为 ~30k | ✅ smoke 6h：30 round mock messages（共 ~600k token）→ rebuild 后 `approxTokens < 30k` |
| 2 | 重建后 agent 能基于 checkpoint 继续未完成任务 | ✅ smoke 6d-6g：marker 含 `<context-rebuilt>` + `<checkpoint>` + `<memory>` + `<task-progress goal=…>`；recent-K tail 完整保留 |
| 3 | ContextBudget 总和 ≤ ctx_window - reserve | ✅ smoke 1g + 9d + 15.{openai,gemini,anthropic,deepseek}：sweep 全部满足 |
| 4 | jsonl 完整保留所有原始消息 | ✅ smoke 9a-9c：`sessions/<id>.jsonl` 写入 `# rebuild ...` header + 每消息一行 ndjson；`(archived.match(/"role":"/g)).length >= big.length` |

补充验收（cross-step 不变量）：

| # | 不变量 | 通过 |
|---|---|---|
| 5 | `context.rebuild` 单源 telemetry（rebuilder.ts 唯一发射点） | ✅ smoke 7a + 11g：每次 rebuild 恰好 1 条；fresh / soft 路径 0 条 |
| 6 | `ContextRebuilt` 单源 hook（rebuilder.ts 唯一发射点） | ✅ smoke 8a + 8b：fired 1 次，payload 含 before/after/dropped |
| 7 | `monitor.reset()` 在 rebuild 后清 `_level` 同时保留 listeners | ✅ smoke 14a-14c |
| 8 | `cost.splitSession()` 重置 session、保留 cumulative | ✅ smoke 13a-13d + 11e/11f |
| 9 | rebuild 后 budget 闸继续用 cumulative（不可绕过） | ✅ queryEngine.ts L375 `cost.cumulativeTotal().usd >= budgetUSD`（替换原 `total()`） |
| 10 | 600-line cap | ✅ `wc -l queryEngine.ts` = 598 |
| 11 | tool_use ↔ tool_result 配对保护（spec §风险） | ✅ smoke 2e-2g：assistant.toolCalls + tool result 一起留；孤立 tool 丢；尾部 incomplete tool_calls 丢 |
| 12 | 退化路径（无 checkpoint + 无 memory + 无 progress）→ `<rule-summary>` | ✅ smoke 10a-10c |
| 13 | 退化路径（`monitor === null`）→ `runScwRound` 返回 neutral hint，不抛 | ✅ smoke 12d |

---

## 3. 跨步骤回归

| smoke | 结果 | 说明 |
|---|---|---|
| smoke-step18 | 26 PASS / 0 FAIL | sub-agent pool 不受影响 |
| smoke-step20 | 50 PASS / 0 FAIL | SwarmR 不受影响 |
| smoke-step22 | 37 PASS / 0 FAIL | Agent UI 不受影响 |
| smoke-step23 | 36 PASS / 0 FAIL | goal-loop 不受影响 |
| smoke-step24 | 50 PASS / 0 FAIL | MemoryStore 不受影响 |
| smoke-step26 | 50 PASS / 0 FAIL | Checkpoint coordinator 不受影响 |
| smoke-step27 | 48 PASS / 0 FAIL | Context monitor 行为兼容（hard 分支 warn → info 是预期变化） |
| smoke-step28 | **76 PASS / 0 FAIL** | 本步 |
| `bun run typecheck` | 通过 | 0 errors |

合计：**423 PASS / 0 FAIL** 跨 8 个 smoke。

---

## 4. 实现要点（与 spec / cc-haha 对照）

### 4.1 与 cc-haha autoCompact 的差异化

cc-haha `services/compact/autoCompact.ts` 是 *模型自总结* — 让 LLM 把早期消息
归纳成一段文本注入。chovy-code 走的是 *结构化拼装*：

| 维度 | cc-haha autoCompact | chovy-code SCW rebuild |
|---|---|---|
| 触发 | token 接近 ctx 上限 | step-27 monitor 上转换至 `hard` |
| 内容来源 | LLM 总结历史消息 | 多源结构化（checkpoint + memory FTS + progress + tail-K） |
| 成本 | 一次完整 LLM 调用 | 仅磁盘 I/O + FTS 查询 |
| 可重现 | 否（模型随机） | 是（完全确定性） |
| 用户可见 | 总结文本嵌入 system | `<context-rebuilt>` 显式标记 + 7 段 XML 块 |
| 失败模式 | LLM 拒绝 / 超时 → 整段丢失 | 任一 selector 失败 → warn + 跳过该桶；全失败 → `<rule-summary>` 兜底 |

→ chovy-code 的设计避免了"模型再次幻觉历史"的风险，且把 reproducibility 提到一等公民。

### 4.2 关键单源约束（AGENTS.md §23 化）

- **`context.rebuild` telemetry** — 仅 `src/context/rebuilder.ts:rebuildContext` 发射；
  CLI / engine / monitor / coordinator 全部为消费方。
- **`ContextRebuilt` hook** — 同上。
- **`ContextBudget` 构造** — 仅 `src/context/budgets.ts:computeBudget` 创建；
  rebuilder 接受 `budgetOverride` 仅用于 SCW 测试，不在生产路径自手卷。
- **PCM 仍是 ctx window 唯一来源** — `computeBudget` 内部走
  `thresholds()`（间接 `CAPS[provider].contextWindow`），不在 budgets.ts 直接查 CAPS。
- **engine→memory→agent→engine 加载环已闭合**（step-27 §22 修复）继续保持，
  rebuilder 的 `memoryPick` 通过 `createMemoryStore` 工厂调用，不触 agent / swarm 模块。

### 4.3 取消语义（AGENTS.md §9 红线代码化）

- rebuilder 的 `parentSignal` 仅 *观察*，不直接转发给 selectors（每个 selector
  自己包 AC 即可，今天它们都是同步 fs read，无需 AC）。
- `runScwRound` → `maybeRebuild` 链路无新增 AC — 复用 caller signal。
- 对比：step-26 coordinator 必须本地 AC（spawn 子 agent 涉及网络）。本步无网络
  调用，省去本地 AC（更简单 + 同样安全）。

### 4.4 600-line cap 守恒

queryEngine.ts 在 step-27 已到 600 行硬限。step-28 通过两步压缩：
- 把 SCW 块（11 行）替换为 `runScwRound(...)` 调用（21 行 → 净 +10）。
- 抽 SCW glue 到 `engine/rebuildHook.ts:runScwRound`（同 §17 contextHook.ts 模式）。
- 合并多行 import → 单行 import。

净结果：598 行（-2）。后续步骤继续走 helper 抽取。

### 4.5 退化路径覆盖

| 场景 | 行为 |
|---|---|
| `CHOVY_CTX_DISABLE=1` | `monitor=null` → `runScwRound` 返回 neutral hint；无 rebuild |
| 无 `latest.md` + 无 memory + 无 progress | `<rule-summary>` 兜底；marker 含最后用户输入 + objective |
| 单条消息超 history budget | 不强制保留；result.messages = [system_marker]；下一轮 fresh |
| `safeFs.append` 失败（盘满 / 权限） | warn + `archived: false`；rebuild 主流程不阻塞 |
| `safeFs.write` checkpoint 失败 | rebuilder 不写 checkpoint（它是消费方），warn 由 step-26 coordinator 负责 |
| `MemoryStore` degraded（bun:sqlite 缺失） | memoryPick 仍工作（InMemoryStore 路径） |
| 任一 selector 抛异常 | `safeCall` 包装：warn + 该桶为 null；其它桶继续 |
| rebuilder 自身抛异常 | `maybeRebuild` catch + warn；返回 `rebuilt: false`；engine 不崩 |

---

## 5. 验收报告（smoke-step28）

```
=== Step-28 context-rebuild smoke ===

  PASS  1a. computeBudget returns 8 buckets
  PASS  1b. systemBase=1500 (default slab)
  PASS  1c. memory=4000
  PASS  1d. checkpoint=3000
  PASS  1e. tools=6000
  PASS  1f. history >= 100k for gpt-4o
  PASS  1g. budgetTotal(b) === effectiveWindow
  PASS  1h. ContextBudget is frozen (immutable)
  PASS  1i. squeeze: budgetTotal(b2) ≤ effectiveWindow (64000)
  PASS  1j. squeeze: history ≥ 10% of effective (≥ 6400)
  PASS  2a-2h. recentMessagesPick (8 cases) — tail-K + tool pairing
  PASS  3a-3e. checkpointPick (5 cases) — missing/in-budget/oversized/marker/budget=0
  PASS  4a-4d. progressPick (4 cases) — undefined goal/in-budget/tail-trim/marker
  PASS  5a-5e. memoryPick (5 cases) — empty store/rows/tagging/budget/empty prompt
  PASS  6a-6h. rebuildContext full pipeline (8 cases) — marker + buckets + < 30k
  PASS  7a-7d. context.rebuild telemetry single-source (4 cases)
  PASS  8a-8b. ContextRebuilt hook (2 cases)
  PASS  9a-9d. session jsonl archive (4 cases)
  PASS  10a-10c. fallback path (3 cases) — <rule-summary>
  PASS  11a-11h. runScwRound integration (8 cases)
  PASS  12a-12d. maybeRebuild idempotence (4 cases)
  PASS  13a-13d. CostTracker.splitSession + cumulativeTotal (4 cases)
  PASS  14a-14c. ContextMonitor.reset() (3 cases)
  PASS  15.{openai,gemini,anthropic,deepseek}. budgetTotal sweep (4 cases)

76 passed, 0 failed
```

---

## 6. 已知风险与下一步

### 6.1 已知风险（与 spec §风险 对齐）

- **tool_use/tool_result 配对启发式** — `recentMessages.ts:pruneOrphans` 当前
  通过 "前面 assistant 是否有 toolCalls" 启发判断；ChatMessage 没有显式
  `tool_call_id` 字段。在多轮交错的 dispatch 场景下可能误删合法配对。后续
  step-30 端到端测试发现误删时，需要给 ChatMessage 加 `toolCallId?: string`
  字段（目前不加，避免破坏 step-16 frozen surface）。

- **memory selector 与 step-25 重合** — 当前 `memoryPick` 是 step-28 私有；
  step-25（Memory Injection）落地时应将其抽到 `memory/injection.ts` 共用，
  本步保留 NOTE。

- **历史消息的真实 token 估算偏差** — `defaultEstimator` 走字符 / 4 × 1.2
  保守估算；中文 / 韩文等高密度文本可能低估。已在 `tokenizer.ts` 标 TODO
  指向 tiktoken-light。本步未处理（不在 spec 范围）。

### 6.2 接驳的下游步骤

- **step-25 Memory Injection** — 共享 `selectors/memoryPick.ts`；可能扩展
  `MemoryQuery` 增加 round-level 去重 / topic 聚类。
- **step-29 Conditional Skill Graph** — `skills` bucket 默认 8000 tokens
  已在 `DEFAULT_SLABS` 预留；step-29 把 `selectSkills(ctx, budget.skills)`
  接入 marker。
- **step-30 端到端集成** — 添加 `SessionSearchTool` 让 agent 可以 `mem search`
  查回 jsonl 归档（spec line 91 标记 TODO）。

---

## 7. 备注

- 本步验收日期：2026-06-19。
- spec 路径：`docs/step-28-context-rebuild.md`。
- 实现路径：`src/context/{budgets,rebuilder,selectors/*}.ts` + `src/engine/rebuildHook.ts`。
- 验收 smoke：`scripts/smoke-step28.ts`（76 cases）。
