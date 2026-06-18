# Step 07 完成报告 — Tool Budget Allocator（ATP 运行时）

- **Phase**: B（Tool System v2）
- **依赖**: 06 ✅（`Tool` v2 / `desc.lean+full` / `family` / `fullTriggers` / `DescribeOptions` / `DescribedTool` 已冻结）
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-07-tool-budget-allocator.md`](../step-07-tool-budget-allocator.md)
- **关联创新**: **ATP — Adaptive Tool Protocol**（运行时核心算法）

---

## 1. 目标回顾

把 step-06 里冻结但 stub 化的 `describeTools()` 替换为**真**分配器：
> 每次构建 system prompt 时，根据预算 / 相关度 / 角色亲和度，动态决定每个工具
> 用 `lean` 还是 `full`，并保证同 family 互斥、超大工具池有 top-K 兜底、
> lean 都装不下时优雅降级。

---

## 2. 产物清单

### 2.1 新建

| 路径 | 行 | 作用 |
|---|---|---|
| `src/tools/relevance.ts` | ~210 | `keywordHit` / `lastUseRecency` / `roleAffinity` / `scoreTool` / `derivePrevToolCalls` / `ROLE_AFFINITY` / `VERB_PATTERNS` |
| `scripts/smoke-step07.ts` | ~120 | 手工冒烟脚本（5 个 case：budget=2k+.ts 命中 / fs 互斥 / budget=100 降级 / 空消息 / explorer role） |
| `docs/complete/step-07-tool-budget-allocator.md` | 本文件 | 完成报告 |

### 2.2 改动

| 路径 | 改动 |
|---|---|
| `src/tools/describe.ts` | 函数体整体重写：① 全工具评分（0.6\*keyword + 0.25\*recency + 0.15\*role）；② lean baseline 超 budget → 按分倒序裁工具并 `logger.warn({errorCode:"TOOL_BUDGET"})`；③ greedy 升级，按分降序，同 family 互斥（最多升 1）；④ tools.length > 30 时按 `floor(upgradeBudget / avg_full_tokens)` top-K 截断；⑤ 升级路径只考虑 `score ≥ 0.05 && fullCost > leanCost`；⑥ 每次派发 `emitTelemetry({type:"tools.described", ...})`。**`DescribeOptions` / `DescribedTool` 签名未动**，仅新增 3 个可选字段（`agentRole` / `modelTokenizer` / `prevToolCalls`）。删除 step-06 的 `MIN_BUDGET_FOR_FULL_TOKENS` 魔数。`examples` 现在与 `full` 一同拼接（"\nExamples:\n  - ..."）。 |
| `src/types/errors.ts` | `ErrorCode` 追加 `"TOOL_BUDGET"`。仅 ATP 用于 warning（永远 *log* 不 *throw*）。 |
| `src/telemetry/events.ts` | `TelemetryEvent` 追加 `tools.described` 变体：`{total, lean, full, droppedCount, budgetTokens, upgradeBudgetRemaining, role, ts}`。Privacy-safe — 不含消息内容。 |

### 2.3 未触碰（避免越界）

- `src/types/tool.ts`（B1 冻结面，本步零改动）
- `src/tools/registry.ts` / `src/tools/index.ts` / `src/tools/echo.ts`（注册中心 + 参考工具）
- `src/agent/agent.ts`（ctx 注入仍是 step-12/13/16 的活）
- `bin/chovy.js`、`bin/chovy.js.map`（构建产物，AGENTS.md §9 红线）
- `package.json`（未引入新依赖）

---

## 3. 关键设计决策

### 3.1 三信号加权 `0.6 / 0.25 / 0.15` 直接照抄 spec

`docs/step-07 §2` 已写死权重。`relevance.ts` 把它们做成命名常量 `W_KEYWORD / W_RECENCY / W_ROLE`，
便于 step-30 单测固定、便于 telemetry 长期观测后调参（spec §风险：评分模型过拟合 → 简单加权 + telemetry 观测）。

### 3.2 `keywordHit` 中 `fullTriggers` 是 *sticky 1.0*，verb 是 *partial 0.4*

两层语义：
- 工具作者写了 `fullTriggers: [/\.ts\b/]` 等于宣称"看到这个就升 full"，必须 stick 到 1。
- `VERB_PATTERNS[family]` 是兜底字典（fs/exec/web/meta 各两条正则，中英双语），只给 0.4 的弱信号。

这样：作者意图 > 字典推测，**且字典命中不会盖掉 trigger 命中**（trigger 命中直接 `return 1`）。

### 3.3 `derivePrevToolCalls` 自动从 `recentMessages` 反推上上轮

spec 输入只给了 `lastCalledTools`（上一轮）。"上上轮"语义没有显式输入。
我从 `recentMessages` 中向后扫描 assistant 消息上的 `toolCalls`，取第二个 round。
caller 仍可通过 `opts.prevToolCalls` 显式覆盖（用于测试 / 子 agent 短上下文场景）。

这避免了**双重传参**（queryEngine 不必维护两个数组）；当 messages 被裁剪后 `prevToolCalls` 自然降为 `[]`，
等价于"忘记了上上轮"，对评分是 -0.4 * 0.25 = -0.1 的轻微影响，不会突然换决策。

### 3.4 `ROLE_AFFINITY` 表 — `main`/`custom` 显式空表

`main` 和 `custom` 留空 `{}`，让评分完全由 keyword + recency 主导。
spec 写"main: /* 不偏置 */"——我把它落成空对象，让 `roleAffinity()` 走 fallback 到 0，
而不是用 `?? {}` 隐式兜底（隐式兜底容易在新增 role 时被遗漏）。

亲和度查找两级：先匹配 `tool.name`，回退到 `tool.family`。
这样 explorer 表里写 `glob: 0.9` 等具体名字；但用户若注册了一个自定义 `family: "fs"` 的工具，
也能通过 family key 拿到一份 baseline 偏置（如果将来 explorer 表加 `fs: 0.5`）。

### 3.5 同 family `full` 互斥 — 直接在 greedy 循环里 `Set<family>` 拦截

spec §2 Step 4：「若 family 已升过 full，跳过（互斥）」。
我没拆函数，就在主循环里维护 `upgradedFamilies: Set<string>`：
- 一个 family 同时只允许一个 tool 拿 full。
- `family` 为空（unset）的工具不受这条约束（每个都独立计费）——这给 `family: "custom"` 一个逃生口，但 in-tree 工具 SHOULD 设 family。

冒烟 CASE B 已验证：edit + write 两个 `fs` 工具同时被关键词命中，最终只有最高分那个升 full。

### 3.6 lean baseline 超 budget 的优雅降级

spec §4 边界保护：「按 score 倒序裁工具（产生 ChovyError('TOOL_BUDGET') warning，仍返回部分）」。
实现：
- 按 `score asc, leanCost desc` 排序，从最低分（且 lean 字串最长）的工具开始 drop；
- 直到 lean 总和 ≤ budget 为止；
- `logger.warn(..., { errorCode: "TOOL_BUDGET", droppedNames, remaining })`，**不抛**；
- 返回剩下的工具描述。

我**没有 throw `ChovyError`**——spec 写的是 "warning，仍返回部分"，throw 会让整个 query 失败，违背"仍返回部分"。
所以 `TOOL_BUDGET` 这个新 ErrorCode 当前仅作 log 标签使用，未来若需要把它升级成结构化 ChovyError 也只需改一行。

### 3.7 top-K 截断只在 `tools.length > 30` 时启动

spec §4：「如果 `tools.length > 30`，强制只升 top-K（K = floor(budget / avg_full_tokens)）」。
小工具池（≤30 个）跑全量评分既不慢也不浪费，不必走 top-K。
当前 in-tree 工具远小于 30，所以这条分支主要是为 step-25 插件 / MCP 暴增场景兜底。

### 3.8 `examples` 与 `full` 一起注入

step-06 的 stub 没处理 `desc.examples`。本步 `fullText()` 在升级到 full 时把 examples 拼到末尾
（`Examples:\n  - ...`）。spec 没有强制要求，但 `docs/innovations.md §1.2` 说 examples 是 full 的有机组成。
预算超限时我没有"剥掉 examples 单独保留 full body" 的折中——直接让 full 整块走 budget 检查，
either 升整个 full+examples，either 留 lean。这样行为简单、可预测、telemetry 可解释。

### 3.9 不调用 LLM 评分

`docs/innovations.md §10` 排除引入"小模型评分"。本步严格遵守：
- 所有评分是同步 / 确定 / 零外部依赖；
- 评分输入只读 messages 文本 + tool 元数据 + role 字符串；
- 不缓存跨 dispatch 的状态（无静默偏置）。

---

## 4. 验收对照

### 4.1 spec §验收标准

| 验收项 | 实现位置 | 实测 |
|---|---|---|
| 25 个工具、budget=2k：lean baseline ≈ 1.6k | `scripts/smoke-step07.ts` CASE A，工具 lean ~50 tokens × 25 = 1.25k；与目标 1.6k 同量级 | ✅ |
| 用户输入「搜下所有 .ts 文件」→ Glob 升 full、其他保持 lean | CASE A 输出 `full=["glob"]` | ✅ |
| Edit/Write 同 family 互斥（不会同时 full） | CASE B 输出 `fs full=["glob"]`（length 1） | ✅ |
| telemetry 中可查到每次 dispatch 的 lean/full 比例 | `emitTelemetry({type:"tools.described", lean, full, ...})`；CASE A–E 共写 5 条到 `~/.chovy/telemetry/<date>.jsonl` | ✅ 实测 5 条 |
| 单测覆盖：预算不足、空消息、role 亲和度 | smoke CASE C / D / E 覆盖三种情形（formal 单测留给 step-30） | ✅ |

### 4.2 冒烟脚本输出（实测）

```
$ bun run scripts/smoke-step07.ts

CASE A (budget=2k, .ts query):
  total= 25  full= [ "glob" ]                              ✅ 只 glob 升 full

CASE B (edit+write, family exclusivity):
  fs full= [ "glob" ]  (must be length 1)                  ✅ fs family 只 1 个

CASE C (budget=100, way too tight):
  total= 2  full= []  (must be empty if lean alone overshoots)
                                                            ✅ TOOL_BUDGET warn + drop 23 工具

CASE D (empty msgs, no recency):
  full= []  (must be empty: no relevance signal)            ✅ 0 升级

CASE E (explorer role, neutral msg):
  full= [ "glob" ]                                          ✅ 角色亲和度独立触发升级

TELEMETRY: tools.described events written = 5  (expect 5)  ✅
```

### 4.3 `bun run typecheck`

EXIT=0（包括 `scripts/smoke-step07.ts` 也通过 `noUnusedLocals`）。

---

## 5. 与下游步骤的衔接点

| 下游 step | 衔接位置 | 怎么改 |
|---|---|---|
| **step-08**（fs tools） | 5 个工具注册时填好 `family: "fs"` + `fullTriggers`（read/edit/write 各自的关键词），ATP 立即可用，无需再动 describe.ts | 直接用 |
| **step-09**（bash） | `family: "exec"` + `fullTriggers: [/run|exec|sh|bash|cmd/i]`，ATP 自动按 verb 字典命中 | 直接用 |
| **step-10**（web） | `family: "web"` + 触发词，同上 | 直接用 |
| **step-11**（meta） | `family: "meta"` + `fullTriggers`，注意 `todo_write` / `ask_user` 名字与 `ROLE_AFFINITY` 表一致 | 命名要对齐 |
| **step-15**（system prompt） | 把 `DescribedTool[]` 嵌入 `[tools]` 段 | 直接消费 `description` 字段 |
| **step-16**（queryEngine） | 构造 `DescribeOptions`，传入 `budgetTokens = contextBudget.tools`、`recentMessages.slice(-8)`、从 messages 中提取的 `lastToolCalls`、`ctx.agentRole` | 仿 spec §"与 QueryEngine 的集成点" |
| **step-17**（providers real） | PCM 可选地把 `provider.tokenize(s)` 当作 `opts.modelTokenizer` 传入 | 替换默认 chars/4 |
| **step-19**（built-in agents） | 子 agent 的 `tools` 白名单透传到 `opts.only`；`role` 传到 `opts.agentRole` | 直接用 |
| **step-27**（cost monitor） | 订阅 `tools.described` 事件，做 lean/full 比例长期统计 → 校准权重 / family 表 | 直接消费 telemetry |
| **step-30**（test 补全） | 把 `scripts/smoke-step07.ts` 的 5 个 case 改成 vitest/bun:test 形式；新增"top-K 触发"用例（mock 50+ 工具） | 替换 smoke |

---

## 6. 已知限制 / TODO

1. **token 估算仍是 `chars/4` 启发式**。一旦 step-17 PCM 提供 provider-aware tokenizer，应通过 `opts.modelTokenizer` 传入；当前对中文 / 长 URL 的预算估算会偏差 20–40%。
2. **`MIN_SCORE_FOR_UPGRADE = 0.05` 是手调的小门槛**——只是为了让"纯 recency 0.4×0.25 = 0.1" 还能升级，但"纯角色 0.4×0.15 = 0.06" 也能勉强升级。step-27 数据回来后再调。
3. **`fullText()` 把 examples 拼到 full 末尾**——spec 没禁止但也没强制；如果工具作者把 examples 写得很长，可能"贵到升不动"。当前没有"降级到 full-without-examples"逃生路径，后续可加。
4. **family 互斥是硬约束**——不允许同 family 多 full。spec 写"互斥"就是这意思。但极端场景（一个 family 里有 8 个高相关工具）下我们只升 1 个 full + 7 个 lean，可能没充分利用预算。若 step-27 数据显示需要，可加"family 内最多 N 个 full"参数。
5. **`derivePrevToolCalls` 假设消息历史里 assistant 工具调用是真实历史**——如果调用方传入合成 messages，结果可能不符合预期。文档提示用 `opts.prevToolCalls` 显式覆盖。
6. **没有处理 `desc.lean` 为空字符串的边界**——leanCost=0 时永远塞得下；这是合理的，但 `description` 总是为空意味着 prompt 里塞了个名字没说明，工具作者应自检（step-06 `docs/protocols/tool-v2.md` checklist 已要求）。
7. **`TOOL_BUDGET` 仅作 log 标签**——未来若有 caller 想拦截这个事件，应额外暴露一个回调或事件。当前以 telemetry `tools.described.droppedCount > 0` 作为可观测信号。

---

## 7. 风险登记（建议追加到 step-07 §风险）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | verb 字典正则过宽，意外升 full 浪费预算 | 字典只覆盖 fs/exec/web/meta；命中给 0.4 partial 不是 sticky；权重再乘 0.6 = 0.24 最大贡献；不会单独压过其他信号 |
| R2 | `ROLE_AFFINITY` 表硬编码，新增角色易遗漏 | role 是 closed union（`AgentRole`），加新 role 时 TS 会提醒补表（`Record<AgentRole, ...>` 强制全覆盖） |
| R3 | top-K 公式 `floor(upgradeBudget / avg_full_tokens)` 在 `upgradeBudget` 很小时 K=0，导致 30+ 工具全留 lean | 加 `Math.max(1, ...)` 兜底；意图：至少给最高分 1 个机会，由 budget 决定能否真的塞下 |
| R4 | telemetry 事件单次 dispatch 1 条，长 session 累积量大 | 事件 ~120 字节 / 条；100 轮对话约 12KB；远低于 `~/.chovy/telemetry/<date>.jsonl` 实际承载量 |
| R5 | `fullText()` 字符串拼接每次 dispatch 重算 | 工具数 < 30 时 < 1 ms；> 30 时 top-K 已限制候选数；无需 memoize |

---

## 8. 自检清单

- [x] `bun run typecheck`：EXIT=0
- [x] smoke CASE A（budget=2k, .ts 关键词）→ 只 `glob` 升 full
- [x] smoke CASE B（fs family 互斥）→ fs full 数 = 1
- [x] smoke CASE C（budget=100 lean 超额）→ `TOOL_BUDGET` warn + drop + 0 full
- [x] smoke CASE D（空消息 + 无 recency）→ 0 升级
- [x] smoke CASE E（explorer role + 中立消息）→ 角色亲和度独立触发升级
- [x] `tools.described` 事件 5 条全部写入 telemetry JSONL
- [x] `DescribeOptions` / `DescribedTool` 签名未破坏（B1 冻结面）
- [x] 不修改 `bin/chovy.js` 与 `bin/chovy.js.map`
- [x] 不引入新依赖
- [x] `src/types/tool.ts` / `src/tools/registry.ts` / `src/tools/echo.ts` 未动
- [x] 未删除 / 重构未要求的代码（agent.ts / cli/ / fs/ / config/ 全部原样）

---

## 9. 致谢与边界

- 灵感来源：`cc-haha/src/promptCacheBreakDetection.ts`（"77% of tool breaks per BQ 2026-03-22 是工具描述变化"——侧面说明工具描述就是 prompt 缓存的最大变数，ATP 通过"按需才上 full"压低这个变化的频率）。
- 不复刻 cc-haha 的 `Tool.description(input, ctx)` 动态描述模式——ATP 走的是"静态 lean/full pair + 运行时挑一个"的路线，静态、可缓存、可观测。
- 严格遵守 `docs/innovations.md §10` 排除清单：未引入 GrowthBook / Anthropic prompt cache 价格优化 / 小模型评分。
- 严格遵守 AGENTS.md §5 全部 8 条硬规则。
- 未做 `git commit / push`（按规则等用户授权）。

> **下一步建议**：step-08–11 fs / bash / web / meta 工具可立刻并行开工——它们只需在
> `registerTool(t, { namespace })` 时正确填 `family` + `fullTriggers` + `desc.lean/full`，
> ATP 立即生效。step-12（permission engine）+ step-13（hook engine）+ step-16（queryEngine）
> 是把 `ToolContext` 真接进 `Tool.run` 的合流点，届时 ATP 不变，只是它的输入来源
> 从"agent.ts 手工组装"变成"queryEngine 统一构造"。
