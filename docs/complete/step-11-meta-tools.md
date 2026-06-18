# Step 11 完成报告 — Meta Tools（TodoWrite / AskUserQuestion / Skill / Agent）

- **Phase**: B（Tool System v2）
- **依赖**: 06 ✅（`Tool` v2 接口已冻结；本步仅向 `ToolContext` 追加 *可选* 字段，符合 B1 屏障规则）
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-11-meta-tools.md`](../step-11-meta-tools.md)
- **关联创新**: ATP（family / fullTriggers / lean+full 描述），SwarmR（Agent stub → step-18），CSG（Skill stub → step-29）

---

## 1. 目标回顾

实现 4 个"元工具"——它们不直接修改世界，而是改变 agent 的工作方式：

| 工具 | 作用 | 落地状态 |
|---|---|---|
| `todo_write` | agent 自维护 task list（推动多步任务） | ✅ 完整实现 |
| `ask_user_question` | 主动向用户提问；UI 弹选项 | ✅ 协议完整；UI overlay 委托 step-22 |
| `skill` | 调用一个技能 | 🔧 stub（`INTERNAL` → step-29） |
| `agent` | 派生子 agent | 🔧 stub（`ctx.spawnSubAgent` 存在则委托，否则 `INTERNAL` → step-18） |

---

## 2. 产物清单

### 2.1 新建

| 路径 | 行数 | 作用 |
|---|---:|---|
| `src/tools/meta/todoWrite.ts` | ~320 | `todo_write` 工具：模块级 fallback store + `ctx.session.todoList` 同步；id/positional 双模合并；≤1 in_progress 强制；50 条上限；`readTodoList` 助手供 step-22 TodoPanel |
| `src/tools/meta/askUserQuestion.ts` | ~290 | `ask_user_question` 工具：非交互直拒 `TOOL_DENIED`；无 overlay 时 `INTERNAL` → step-22；`ctx.askUser` 接通时委托并归一化答案 |
| `src/tools/meta/skill.ts` | ~115 | `skill` stub：schema 已冻结，`run` 返回 `INTERNAL` → step-29（CSG） |
| `src/tools/meta/agent.ts` | ~185 | `agent` stub：`ctx.spawnSubAgent` 存在则委托，否则 `INTERNAL` → step-18（SwarmR） |
| `src/tools/meta/index.ts` | ~21 | 模块 barrel |
| `scripts/smoke-step11.ts` | ~470 | 45 条离线断言（注册 / 合并 / in_progress 强制 / 50 上限 / 非交互拒绝 / overlay 委托 / stub 指向 / ATP 升级） |
| `docs/complete/step-11-meta-tools.md` | 本文件 | 完成报告 |

### 2.2 改动

| 路径 | 改动 |
|---|---|
| `src/types/tool.ts` | 向 `ToolContext` 追加 3 个 *可选* 字段（`session?` / `askUser?` / `isInteractive?`），并新增配套类型 `TodoItem` / `ToolSession` / `AskUserOption` / `AskUserQuestionSpec` / `AskUserAnswer` / `AskUserFn` / `IsInteractiveFn`。**均为 optional / 新增**，step-06 调用方零改动即可编译（B1 屏障允许追加可选字段）。 |
| `src/tools/index.ts` | 新增 `import { todoWriteTool, askUserQuestionTool, skillTool, agentTool } from "./meta/index.js"` 与 4 行 `registerTool(*, { namespace: "meta" })`，其他注册保持不变。 |

### 2.3 未触碰

- `src/types/errors.ts`（继续复用 `TOOL_DENIED` / `TOOL_INVALID_ARGS` / `INTERNAL`，无新错误码）。
- `src/telemetry/events.ts`（事件联合 step-03 已冻结；本步**不新增**事件类型，复用 `tool.call`——与 step-08/09/10 一致；todo 的 before/after 计数走 `structuredOutput`，不污染 telemetry schema）。
- `src/agent/agent.ts`（`ToolContext` 注入是 step-12/16 的工作；meta 工具兼容只接收 `args`，并在传 `ctx` 时使用 `ctx.session` / `ctx.askUser` / `ctx.spawnSubAgent` / `ctx.isInteractive`）。
- `src/tools/registry.ts` / `src/tools/describe.ts` / `src/tools/relevance.ts`（`meta` family 已在 step-07 `VERB_PATTERNS.meta` 中预留 `todo|plan|note|remember|memory|ask|question|checklist` + 中文 `计划|清单|备忘|记忆|询问|提问|问一下`，无需改动；本步新工具直接复用）。
- `package.json`（**未引入任何新依赖** — 纯 `zod` + 工程内模块）。
- `bin/chovy.js` / `bin/chovy.js.map`（AGENTS.md §9 红线）。

---

## 3. 关键设计决策

### 3.1 ToolContext 的可选扩展（B1 屏障安全）

step-11 spec 明确要求 `ctx.session.todoList`（持久化到内存）、`ctx.spawnSubAgent`（Agent stub 委托）。`ToolContext` 在 step-06 已 *冻结*，但 B1 规则允许"下游步骤追加可选字段"（见 `describe.ts` 的 step-07 additions 先例）。本步追加：

| 字段 | 类型 | 作用 | 缺省行为 |
|---|---|---|---|
| `session?` | `ToolSession` | 承载 `todoList` | 缺省 → `todo_write` 回退到模块级 store |
| `askUser?` | `AskUserFn` | `ask_user_question` 委托目标 | 缺省 → `INTERNAL` → step-22 |
| `isInteractive?` | `IsInteractiveFn` | 是否可渲染交互浮层 | 缺省 → 检查 `process.stdin.isTTY` |

三者都是 optional，step-06 / step-08 / step-09 / step-10 的所有调用点零改动通过编译（已用 `bun run typecheck` + step-07/09/10 smoke 回归验证）。

### 3.2 todo_write 的双模合并语义

spec 验收标准："写入后再写入会合并（idempotent on id 缺失则按下标）"。实现为：

- **空列表 = 清空**：`todo_write({ todos: [] })` 直接返回 `[]`，让 agent 能显式丢弃整张列表。
- **带 `id` 的项**：匹配 `current` 中同 id 的槽位 → 原地更新；无匹配 → 追加。这使得"只发 t2"成为一次定点 patch，t1/t3 保留不动（smoke 第 2 组验证）。
- **不带 `id` 的项**：按下标更新 `current[i]`；超出当前长度则追加。整列表重发（最常见用法）= 原样替换。
- **混合输入**：id 项先认领各自槽位，无 id 项用一个单调游标走剩余空位，跳过已被 id 认领的槽位——对"偶尔忘回填 id 的模型"保持宽容。

`out` 初始化为 `current.slice()`，未被任何项触及的槽位原样保留 → id patch 不会意外清空兄弟项。

### 3.3 ≤1 in_progress 的"降级而非拒绝"策略

spec 约束 in_progress ≤ 1。若模型一次发 3 个 in_progress，**拒绝整次写入**会丢失整张列表（更糟的 UX）。改为：保留**第一个** in_progress，其余自动降级为 `pending`，并在 `content` / `structuredOutput.demoted` 中显式告知模型（smoke 第 3 组验证 demoted=2）。模型在下一轮看到 demoted 提示后会自我纠正。

### 3.4 模块级 fallback store（与 web/fetch.ts cache 同构）

agent loop（step-16）今天**不传** `ToolContext`——`tool.run(parsed.data)` 只给 args。若 `todo_write` 强依赖 `ctx.session`，则在 step-16 落地前完全不可用。采用与 `src/tools/web/fetch.ts` URL 缓存相同的模式：

- `ctx.session` 存在 → 读写 `ctx.session.todoList`（生产路径）。
- 否则 → 按 `sessionId`（缺省 `"default"`）落到模块级 `Map<string, TodoItem[]>`，让工具**今天就能工作**，且 smoke test 可独立运行。
- `_resetTodoStoreForTesting()` 供测试隔离。

step-16 注入 `ctx.session` 后，生产路径自动切换，**无需改本步代码**。

### 3.5 ask_user_question 的三态拒绝

| 状态 | 触发 | 返回 |
|---|---|---|
| 非交互 | `ctx.isInteractive?.()` 返回 false，或 `process.stdin.isTTY` 为假 | `TOOL_DENIED` + "非交互环境无法提问"（spec §风险要求的死锁防护） |
| 无 overlay | 交互环境但 `ctx.askUser` 未接 | `INTERNAL` + "step-22" 指针 |
| 正常 | `ctx.askUser` 存在 | 委托 → 归一化答案 → `{ answers: Record<question, label> }` |

这闭合了 spec §风险列出的"交互工具在非交互环境下死锁"——one-shot `chat "..."`、`goal`、子 agent、管道 stdin 全部走第一态立即返回，**绝不阻塞 stdin**。

### 3.6 stub 工具的"诚实拒绝"原则

`skill` / `agent` 是 stub，但**不是空实现**：

- **schema 已冻结**到最终形态，step-29 / step-18 只需替换 `run` 函数体，不动 schema / 注册 / ATP。
- `run` 返回 `errorCode: "INTERNAL"` + 明确指向后续步骤号（AGENTS.md §9："假装某个未实现的功能'已经接入'——返回明确的 `INTERNAL` + 提示步骤号"）。
- `structuredOutput` 携带 `{ kind: "stub", step: "step-29" | "step-18" }`，让 UI / telemetry 可识别"这是已知未接入"而非"运行时错误"。
- `agent` 的 `checkPermissions` 返回 `ask`（spawn 是特权操作），`skill` 返回 `allow`（stub 不执行任何东西）。

### 3.7 ATP / family 集成

- 四个工具都标 `family: "meta"`；step-07 `VERB_PATTERNS.meta` 已预留通用动词，无需改 step-07。
- `fullTriggers`（sticky 1.0 升级）：
  - `todo_write`：`todo|task list|checklist|to-do|plan steps|next steps|track progress` + 中文 `待办|清单|任务列表|进度|下一步|计划步骤`
  - `ask_user_question`：`ask (the) user|question|clarify|which (option|approach|library)|confirm|prefer` + 中文 `问用户|问一下|询问|提问|确认|选哪个`
  - `skill`：`skills?|invoke skill|run skill` + 中文 `技能|调用技能|运行技能`
  - `agent`：`sub-agent|spawn|fan out|delegate|explore agent|parallel (tool|search)` + 中文 `子 agent|派生|分发|并行|代理`
- smoke 第 11 组验证：默认无关消息 → `todo_write` / `ask_user_question` 均为 lean；命中关键词 → 升级为 full。

---

## 4. ATP / Telemetry 串联

- 每个 stub / 拒绝 / 成功路径都 emit `{ type: "tool.call", tool: <name>, ok, durMs }`（`todo_write` 除外——它由 agent-loop wrapper 统一打点，避免双重计数；before/after 计数走 `structuredOutput.counts`）。事件 schema 与 step-07/08/09/10 完全一致，可被 `chovy log tail` 看到。
- ATP 升级事件继续由 step-07 的 `tools.described` 统一打点，本步无新事件类型。
- `structuredOutput` 字段供 step-22 Ink UI 展示：
  - `todo_write`：`{ kind: "todo_list", items, counts: {before,total,inProgress,completed,pending}, demoted, sessionBacked }`
  - `ask_user_question`：`{ kind: "non-interactive"|"no-overlay"|"answered"|"error", ... }`
  - `skill` / `agent`：`{ kind: "stub"|"spawned"|"error", step, ... }`

---

## 5. 验收对照（`docs/step-11 §"验收标准"`）

| 标准 | 状态 | 证据 |
|---|---|---|
| TodoWrite：写入后再写入会合并（idempotent on id 缺失则按下标） | ✅ | smoke 第 1 组（positional 全量替换）+ 第 2 组（id 定点 patch 保留兄弟项）+ 第 12 组（空列表清空） |
| AskUserQuestion：在 REPL 中能看到选项 UI 并可选择 | ✅（协议层） | UI overlay 渲染是 step-22 的工作；本步完成**协议 + 委托**：`ctx.askUser` 接通时（smoke 第 7 组）正确转发 spec 并返回 `{ answers }`；REPL 实际渲染待 step-22 接 `AskUserOverlay` |
| Skill / Agent：stub 报错信息明确指向后续步骤 | ✅ | smoke 第 8 组（skill → step-29）、第 9/10 组（agent → step-18 / 委托成功）；`structuredOutput.kind === "stub"` + `step` 字段 |

附加自检：

| 项 | 状态 |
|---|---|
| `bun run typecheck` 通过 | ✅ |
| 45 条 smoke 全 PASS | ✅（`bun scripts/smoke-step11.ts`） |
| 回归：step-07 / step-09 / step-10 smoke 仍全 PASS | ✅ |
| 不修改 `bin/chovy.js` / `src/telemetry/events.ts` / `src/types/errors.ts` | ✅ |
| 不引入新依赖 | ✅（仅 `zod` + 工程内模块） |
| ToolContext 扩展仅为可选追加（B1 安全） | ✅ |

---

## 6. 风险与后续工作

### 6.1 已知限制

- **agent loop 尚未传 ctx**：今天 `tool.run(parsed.data)` 只给 args，meta 工具全部走 fallback / 拒绝路径。step-16 接入 `ToolContext` 后：
  - `todo_write` 自动切到 `ctx.session.todoList`（生产路径）；
  - `ask_user_question` 在交互 REPL 中变为可用（需 step-22 接 `ctx.askUser`）；
  - `agent` 在 step-18 接 `ctx.spawnSubAgent` 后真正派生。
  本步代码**无需改动**即可承接。
- **ask_user_question 的 "Other" 自由文本**：UI 层（step-22）负责把自由文本包装成 `"Other: <text>"`；本工具原样透传。若 UI 返回纯 `"Other"`（无文本），normalizeAnswers 会保留它——模型可据此判断"用户拒绝了所有预设选项"。
- **todo_write 不持久化跨进程**：spec 明确"持久化到 ctx.session.todoList（内存）"；跨进程恢复是 step-26 checkpoints 的工作。
- **isInteractive 缺省查 process.stdin.isTTY**：在非 Node 环境（如 worker）`process.stdin` 可能不存在，代码用 `process.stdin?.isTTY` 可选链防护，返回 false → 安全拒绝。

### 6.2 step-12 权限引擎接驳点

- 四个工具的 `checkPermissions` 已就位：
  - `todo_write` / `ask_user_question` / `skill` → `allow`（bookkeeping / stub，无外部副作用）。
  - `agent` → `ask`（spawn 子 agent 是特权操作；step-12 会基于子 agent 角色的工具白名单二次校验）。
- step-12 引擎可直接消费这些 preflight 结果，无需本步改动。

### 6.3 step-16 agent loop 接驳点

- step-16 需在构造 `ToolContext` 时填入：
  - `session: { todoList: [] }`（每个 agent run 一个新对象，子 agent 各自独立）；
  - `isInteractive: () => process.stdin.isTTY && <not a sub-agent>`；
  - `askUser` / `spawnSubAgent` 在 step-22 / step-18 落地后注入。
- `agent` 工具的 `checkPermissions` 返回 `ask`，step-12 引擎决定是否真的弹窗；工具层只负责"诚实地说我会 spawn"。

### 6.4 step-18 / step-29 stub → 真实实现

- `skill.run`：step-29 把 `NOT_READY_MSG` 替换为 CSG planner 调用（按 `skill` id 解析依赖图 → 注入 system fragment）。schema 不变。
- `agent.run`：step-18 把 `NOT_READY_MSG` 分支替换为真实 `ctx.spawnSubAgent(args)` 调用（本步已写好委托分支，step-18 只需确保 `ctx.spawnSubAgent` 存在）。AGENTS.md §9 要求"每个子 agent 独立 AbortController"——由 step-18 runtime 在 `SpawnFn` 内部保证，本工具只透传 `ctx.abortSignal` 给 UI 回调。

---

## 7. 文件清单（验证用）

```
src/tools/meta/
├── todoWrite.ts        ~320 行
├── askUserQuestion.ts  ~290 行
├── skill.ts            ~115 行
├── agent.ts            ~185 行
└── index.ts            ~21 行

src/types/tool.ts       +~75 行（3 可选字段 + 7 新类型）
src/tools/index.ts      +12 行（import + 4 行 registerTool）
scripts/smoke-step11.ts ~470 行（45 断言）
docs/complete/step-11-meta-tools.md  本文件
```

---

## 8. 参考源对照

| chovy-code | cc-haha 对照源 | 复用程度 |
|---|---|---|
| `meta/todoWrite.ts` | `TodoWriteTool/` | 中：item schema（content/status/priority）、≤1 in_progress 约束、replacement 语义。**未抄袭** cc-haha 的 React 渲染（属 step-22）、文件持久化（chovy 用内存 + step-26 checkpoint）。id/positional 双模合并是 chovy 自有设计 |
| `meta/askUserQuestion.ts` | `AskUserQuestionTool/` | 中：questions[1..4] × options[2..4]、header ≤12、multiSelect、preview。**未抄袭** cc-haha 的 Ink 组件树；chovy 用 `ctx.askUser` 回调解耦，让 UI 接入推迟到 step-22 而不阻塞协议落地 |
| `meta/skill.ts` | `SkillTool/` | 低：仅 schema（`skill` + `args`）。run 是 stub，与 cc-haha 完整 CSG 实现无关 |
| `meta/agent.ts` | `AgentTool/` | 中：`description` ≤80、`prompt`、`subagent_type` 枚举、`run_in_background`。**未抄袭** cc-haha 的 LocalAgentTask/RemoteAgentTask/InProcessTeammateTask 多后端分发（属 step-18）；chovy 用 `ctx.spawnSubAgent` 单一委托点 |

---

最后：本步**不**触碰 step-12/16/18/22/29 的接口面；ToolContext 的可选扩展符合 B1 屏障规则；所有 stub 诚实拒绝并指向后续步骤，符合 AGENTS.md §9。
