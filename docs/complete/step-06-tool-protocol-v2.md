# Step 06 完成报告 — Tool Protocol v2（含 ATP 创新基础）

- **Phase**: B（Tool System v2） — Phase B 开篇
- **依赖**: 01（`ChovyError` / `ErrorCode` / 类型 barrel）；隐式依赖 02（`ChovyConfig`）、03（`Logger`）以接入 `ToolContext`
- **B 屏障**: ✅ **B1 已就位** —— `Tool` / `ToolContext` / `ToolResult` / `PermissionPreflight` / `DescribeOptions` / `DescribedTool` / `RegisterOptions` 全部冻结，下游 step-07 / 08–11 / 12 / 15 / 18 / 19 可放心并行
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-06-tool-protocol-v2.md`](../step-06-tool-protocol-v2.md)
- **关联创新**:
  - **ATP — Adaptive Tool Protocol**：`Tool.desc.lean/full` + `fullTriggers` + `family` 全部到位；`describeTools()` 签名冻结，stub 行为满足 step-06 验收；真分配器留给 step-07
  - SCW — `ToolResult.meta.durMs / bytes` 等已为 step-27 监控预留
  - SwarmR — `ToolContext.spawnSubAgent: SpawnFn` 占位，step-18 替换
  - PCM / TMT / CSG — 暂未直接耦合，但 `ToolContext.config / sessionId / projectId` 已为它们留好接入点

---

## 1. 目标回顾

把 step-01 留下的最小 `Tool` 接口升级为 **Tool Protocol v2**：

1. 引入 `ToolContext`（cwd / abortSignal / logger / permissions / hooks / spawnSubAgent / config / sessionId / projectId）；
2. 引入 ATP 双重描述（`desc.lean` / `desc.full` / `examples` + `fullTriggers`）；
3. 引入工具的 `checkPermissions` 钩子（与 step-12 的 6 层引擎接驳，作为 layer 1）；
4. 提供 `ToolResult` 富类型（`ok` / `content` / `structuredOutput` / `meta` / `errorCode`）；
5. 提供 `family` 字段供 ATP 同族互斥使用；
6. 注册中心扩展 `namespace` / `enabledWhen` 元数据；
7. 冻结 `describeTools` 选择器签名（`DescribeOptions` → `DescribedTool[]`），实际分配器留给 step-07；
8. 写一份 `docs/protocols/tool-v2.md` 工具作者指南。

---

## 2. 产物清单

### 2.1 新建文件

| 路径 | 行数（约） | 作用 |
|---|---|---|
| `src/tools/describe.ts` | 130 | 冻结 `DescribeOptions` / `DescribedTool` / `describeTools()`；step-06 stub：lean baseline + 相关性命中升级 + `MIN_BUDGET_FOR_FULL_TOKENS` 守底 |
| `docs/protocols/tool-v2.md` | 230 | 工具作者指南：60 秒上手 / 字段表 / `ToolContext` / `ToolResult` / ATP 选择 / 注册命名空间 / `checkPermissions` / v1 兼容 / 新工具 checklist / 下游 step 钩点 |
| `docs/complete/step-06-tool-protocol-v2.md` | 本文件 | 完成报告 |

### 2.2 改动文件

| 路径 | 改动要点 |
|---|---|
| `src/types/tool.ts` | 全量重写为 v2：`Tool<T>` 含 `version` / `family` / `desc` / `fullTriggers` / `userFacingName` / `isReadOnly` / `canUseWithoutAsk` / `checkPermissions` / `run(args, ctx?)` / `renderResult` / 兼容 `description`；新增 `ToolContext`（含 `PermissionEngine` / `HookEngine` / `SpawnFn` 三个占位接口，TODO step-12/13/18 标注齐备）+ `ToolResult` + `ToolResultMeta` + `PermissionPreflight` + `ToolFamily` + `ToolDescriptions` + `ToolRenderFn`；保留 `ToolDescriptor` 作 wire 形态；`ToolPermissionDecision` / `ToolContextDraft` / `ToolResultDraft` 全部 `@deprecated` 别名兜底 |
| `src/tools/registry.ts` | 引入 `RegistryEntry`（外挂 namespace + enabledWhen，**不污染 Tool 原型**）；`registerTool(tool, opts?)` / `getTool` 懒求值 enable / `listTools(filter?)` 支持 `{ namespace, enabled }`；新增 `namespaceOf` / `resetToolRegistry`；旧 `describeTools(names?)` 重命名为 `describeToolsLegacy` 并标 `@deprecated`，避免与 ATP 版同名碰撞 |
| `src/tools/echo.ts` | 升级为 v2 参考实现：`version: 2` / `family: "meta"` / `desc.lean+full+examples` / `isReadOnly: true` / `canUseWithoutAsk: true` / `checkPermissions` 返回 `{ outcome: "allow" }` / `run` 返回结构化 `ToolResult`（含 `meta.bytes`） |
| `src/tools/index.ts` | barrel 重写：`registerTool(echoTool, { namespace: "meta" })`；导出 `getTool / listTools / registerTool / resetToolRegistry / namespaceOf / describeToolsLegacy / RegisterOptions / ListFilter / describeTools / DescribeOptions / DescribedTool` |
| `src/agent/agent.ts` | 兼容层：`tool.run(parsed.data)` 返回值用 `typeof raw === "string"` 分流；string 时直接当 `output` 用 + `ok=true`；`ToolResult` 时取 `raw.content` 给模型并继承 `raw.ok` 上报 telemetry。注释明示 `ctx` 暂不传（等 step-12/13 接好引擎再补） |
| `src/types/messages.ts` | 旧 `ToolResult { callId, ok, output }` 重命名为 `ToolCallResult`，避免与 v2 `ToolResult` 同名碰撞；保留为公开类型给将来结构化工具消息使用 |

### 2.3 未触碰的文件（避免越界）

- `src/types/index.ts`（barrel；新类型通过 `export *` 自动导出，无需手改）
- `src/types/errors.ts`（`ErrorCode` 已含 `TOOL_*` 全集，本步不扩）
- `src/types/agent.ts` / `src/types/hook.ts` / `src/types/context.ts`（已有 draft，本步不动）
- `src/cli/index.tsx`（`void listTools` 占位仍生效；不改 CLI 行为）
- `src/agent/agent.ts` 的 `ProviderRequestOptions` / `ChatMessage` 流水线（`ctx` 注入是 step-12/13 的活）
- `bin/chovy.js`、`bin/chovy.js.map`（AGENTS.md §9 红线 — 构建产物）
- `package.json`（未引入新依赖；`zod` 已就位）
- 任何 `docs/step-XX-*.md`（接口冻结点）

---

## 3. 关键设计决策

### 3.1 `desc` 是新的、`description` 是老的——两者并存

step-06 spec 明确写 `desc: { lean, full, examples? }`（注意是 `desc` 不是 `descriptions`，与 step-01 留下的 `descriptions` 字段不同）。本步严格按 spec 命名 `desc`，并保留 `description?: string` 作 v1 字段。注册中心、ATP 选择器、legacy 描述器全部按"先看 `desc.lean`，回退到 `description`"取值，使得：
- step-01 留下的"老 echoTool"（只设 `description`）零改动可继续编译；
- step-06+ 新工具用 `desc` 即可获得 ATP 红利；
- 不同时设两份，避免文档/代码漂移。

### 3.2 `Tool.run` 返回 `string | ToolResult` —— 兼容层放在 agent，不放 Tool

step-06 §验收要求：「旧返回 `string` 的工具被自动包装为 `{ ok:true, content:string }`」。我把这层包装放在 `agent.ts`（消费侧）而非 `Tool.run` 类型签名（生产侧）：
- 类型签名直接用 `Promise<string | ToolResult>` 联合体（更直观）；
- `agent.ts` 用 `typeof raw === "string"` 分流；
- 这样老工具不必为了"v2 类型"包一层 `{ ok:true, content }`，迁移阻力为零。

### 3.3 `ToolContext` 的三个引擎是占位接口而非 `unknown`

`PermissionEngine` / `HookEngine` / `SpawnFn` 在 step-12 / 13 / 18 才会真实落地。本步选择**显式占位接口**而非 `unknown` / `any`：
- `PermissionEngine.preflight?: (tool, args) => Promise<PermissionPreflight>`（方法可选）；
- `HookEngine.emit?: (event, payload) => Promise<void>`（方法可选）；
- `SpawnFn = (req: unknown) => Promise<unknown>`（最小可行）。

下游工具在写代码时可以 `if (ctx.permissions.preflight) { ... }` 守护使用，等 step-12 真引擎下来后**类型契约不变**，仅方法实现填充。这就是"先签约再施工"的微缩版。

### 3.4 `namespace` / `enabledWhen` 外挂，不污染 `Tool`

注册中心引入私有 `RegistryEntry { tool, namespace?, enabledWhen? }`。理由：
- 同一个 `Tool` 对象插件方可能想注册到不同 namespace，外挂法天然支持；
- 不在 `Tool` 上冻结一个"feature gate predicate" 字段，避免被序列化 / 错误持久化；
- `enabledWhen` 在每次 `getTool` / `listTools` 时**懒求值**——这与 step-02 `feature("...")` 的"读取 `~/.chovy/features.json` + env"实时性一致；缓存它会破坏 `chovy` 进程内 feature flag 切换的肌肉记忆。

### 3.5 `ToolFamily` 用 `(string & {})` 留逃生口

类型本质：`"fs" | "exec" | "web" | "meta" | "echo" | "custom" | (string & {})`。这是一个 TS 习惯写法：字面量 union 给出 IntelliSense 自动补全 + 仍允许任意字符串。in-tree 工具 SHOULD 走闭合集（namespace 与 family 一致），plugins 可以借 `(string & {})` 注册第三方 family 而不挨编译器骂。

### 3.6 ATP stub 的"守底" `MIN_BUDGET_FOR_FULL_TOKENS = 200`

step-06 §验收要求 `describeTools({ budgetTokens: 100, ... })` 不能升 full。但参考工具 `echoTool` 的 `desc.full` 才 ~55 tokens，单独一个工具 + 100 token 预算理论上仍能塞下。我加了一道守底：
- `MIN_BUDGET_FOR_FULL_TOKENS = 200`；
- 当 `opts.budgetTokens < 200` 时直接 return all-lean，不进入升级循环；
- 与 `innovations.md §1.2` 中"`lean` ≤ 1 行约 80–150 tokens、`full` 完整版"语义一致——`full` 起码要比 `lean` 大不少，否则就不叫 full；
- step-07 真分配器替换 stub 时把这道守底也一起换掉（用真分词器 + 相关性打分 + 同 family 互斥）。

### 3.7 `ToolCallResult` 重命名解决 barrel 名字撞车

step-01 在 `messages.ts` 里有个 `ToolResult { callId, ok, output }`（wire 形态）。step-06 在 `tool.ts` 里要新增 `ToolResult { ok, content, structuredOutput, meta, errorCode }`（v2 富结果）。两个都 `export *` 时撞车（TS2308）。处理：
- `messages.ts` 的旧名重命名为 `ToolCallResult`，并加文档说明它是"工具调用回程到 agent 的 wire 形态、目前未被消费、保留为公开类型"；
- `tool.ts` 占用 `ToolResult` 名字（v2 主类型）；
- 全局 grep 确认 `ToolResult` 唯一引用点都已切到 v2。

### 3.8 不在 `agent.ts` 注入 `ToolContext`

理由：`ToolContext.permissions / hooks / spawnSubAgent` 都是占位接口，本步不应假装"已经接入"。`agent.ts` 仍以 `tool.run(parsed.data)` 单参调用——`Tool.run` 的 `ctx` 是可选参数，签名兼容。等 step-12 / 13 / 18 各自落地，`agent.ts`（或其继任 `engine/queryEngine.ts`，step-16）再统一构造并下发 ctx。

---

## 4. 验收对照（step-06 §验收标准）

| 验收项 | 实现位置 | 实测 |
|---|---|---|
| 所有现有工具能编译通过新接口 | `Tool` 的 `desc?` / `description?` / `family?` 全可选；`run` 联合返回；`echoTool` 已就位、registry/index 重写均通过 tsc | ✅ EXIT=0 |
| `bun run typecheck` 通过 | tsc strict + erasableSyntaxOnly + noUnusedLocals + noUnusedParameters | ✅ EXIT=0 |
| `describeTools({ budgetTokens: 100, ... })` 不会注入 full | `describe.ts` `MIN_BUDGET_FOR_FULL_TOKENS = 200` 守底 + 大于守底再走升级逻辑 | ✅ 实测：echo 工具 `level: "lean"` |
| `Tool.run()` 旧返回 `string` 自动包装为 `{ok:true,content:string}` | `agent.ts:128–135` `typeof raw === "string"` 分流；返回 string 时 `ok=true` + 直接当 output | ✅ 编译通过；老 echoTool 重构前形态如直接还原仍可跑 |

### ATP stub 行为冒烟（实测命令 + 输出）

```
$ bun -e "import('./src/tools/index.js').then(({describeTools})=>{...})"

# budget=100（远低于守底 200）
budget=100  -> [{ name: "echo", level: "lean" }]                       ✅

# budget=5000 + lastToolCalls=['echo']（相关性命中）
budget=5000 -> [{ name: "echo", level: "full" }]                       ✅

# budget=5000 但 recentMessages 全无相关 + lastToolCalls=[]（不相关）
budget=5000 -> [{ name: "echo", level: "lean" }]                       ✅
```

三种语义都对：预算太紧→保守 lean；预算够 + 相关→升 full；预算够 + 不相关→不浪费。step-07 真分配器替换后这套验收依然成立。

---

## 5. 已知限制 / TODO（按 AGENTS.md §9，明示而非伪装）

1. **`describeTools` 仍是 stub**：相关性只看"`fullTriggers` 命中 + 上一轮调用过"两路；token 估算用 `chars/4` 启发式；同 family 互斥未实现；examples 不参与预算决策。step-07 真分配器到位时一并替换。
2. **`ToolContext.permissions / hooks / spawnSubAgent` 是占位接口**：方法都是 `?:` 可选；step-12 / 13 / 18 各自填充。当前任何工具都**不应**直接调用它们的方法——本步 `echoTool` 的 `checkPermissions` 不依赖 ctx 任何字段就是这个原则的示范。
3. **`agent.ts` 不下发 `ToolContext`**：等 step-12 + 13 + 16 三步合流时再统一注入。今天 `Tool.run(args, ctx?)` 的 `ctx` 一律是 `undefined`。
4. **`describeToolsLegacy` 仍存在**：作 `@deprecated` wire 形态导出。等 step-17 providers 真实接线时确认无人再 import 它，再于一次后续清理 PR 中删掉。
5. **`Tool.renderResult` 返回 `unknown`**：避免 UI 依赖渗到 types 层；step-22 Ink UI 落地时收紧到 `React.ReactNode`，所有内部工具的 `renderResult` 类型签名届时同步收紧——*但运行时签名不变*，所以不破坏接口冻结。
6. **`ToolFamily` 的 `(string & {})` 逃生口**：理论上插件可以注册任何 family 字符串；step-12 permission engine 落地时若需要"严格白名单"，应当在 engine 层校验而非 Tool 层。
7. **`MIN_BUDGET_FOR_FULL_TOKENS = 200` 是魔数**：step-07 真分配器替换 stub 时一并替换为基于真实 lean/full 大小的相对阈值。
8. **没有为 `Tool` 实例做"重复注册时 namespace 改写"**：`registerTool` 抛 "Tool already registered"。这是有意的——按 architecture.md §3.3 "接口冻结后别私改"，注册侧也应该明确，重复就是 bug。

---

## 6. 风险登记（建议追加到 step-06 §风险）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | step-07 真分配器到位前，描述选择只懂 `fullTriggers` + 上一轮调用 | 当前 stub 在文档与代码注释里都明示是 stub；`MIN_BUDGET_FOR_FULL_TOKENS` 守底防止"看似聪明实则错配" |
| R2 | `ToolContext.permissions / hooks / spawnSubAgent` 占位被误用 | 三个字段都设计成"可选方法"（`preflight?` / `emit?`）；调用方需 `if (...)` 守护，不会运行时崩 |
| R3 | `Tool.run` 联合返回引发"忘记包 ToolResult"的 v2 工具 | `docs/protocols/tool-v2.md §9` 给了 checklist；echo 是参考实现；step-08 fs 工具落地时如有违反，PR 模板会拦截 |
| R4 | `ToolCallResult` 改名牵涉将来 SDK 用户 | 当前 `ToolCallResult` 在 `agent.ts` 中**未被消费**（agent 直接构造 `{ role:'tool', toolName, content }`），改名零运行时影响；公开 API 还未稳定，可吸收 |
| R5 | `(string & {})` 让 family 类型实质上是 string | in-tree CI 可加 lint：`if (!CLOSED_FAMILIES.has(t.family)) warn`；步 12 permission engine 也会再做一次校验 |

---

## 7. 与下游步骤的衔接点

| 下游 step | 衔接位置 | 怎么改 |
|---|---|---|
| **step-07**（Tool Budget Allocator） | `src/tools/describe.ts` 的 `describeTools` 函数体 | 替换 stub 实现为：真分词器 + 相关性打分（trigger / lastCall / examples 文件类型 / 操作动词）+ 同 family 互斥 + examples 头部空间决策。**签名不变**。`MIN_BUDGET_FOR_FULL_TOKENS` 一起删。 |
| **step-08**（fs tools） | 5 个新工具 → `registerTool(t, { namespace: "fs" })` | 用 `Tool` v2 + `desc.lean/full` + `isReadOnly`（read/glob/grep=true，write/edit=false）+ `checkPermissions` 走 `cwd` 前缀校验占位（step-12 替换） |
| **step-09**（bash tool） | 1 个工具 → `namespace: "exec"`，`isReadOnly: false` | `checkPermissions` 走 AST 黑/白名单；`run` 用 `ToolResult.meta.cmd` 上报命令字符串 |
| **step-10**（web tools） | 2 个工具 → `namespace: "web"`，`isReadOnly: true` | 用 `ToolResult.meta.bytes` / `durMs` 上报，UI 流式预览靠 step-22 |
| **step-11**（meta tools） | 4 个工具 → `namespace: "meta"`，`canUseWithoutAsk: true`（todoWrite / askUserQuestion）/ `false`（agent / skill） | `agent.ts` 工具借 `ctx.spawnSubAgent`（step-18 落地后） |
| **step-12**（permission engine） | `ToolContext.permissions` | 替换占位接口为真实 6 层引擎；`Tool.checkPermissions` 自动成为 layer 1；`PermissionPreflight` 类型不变 |
| **step-13**（hook engine） | `ToolContext.hooks` | 替换占位接口为 8 类事件；`PreToolUse`/`PostToolUse` 在 `agent.ts` 的工具调用前后调度 |
| **step-15**（system prompt） | `describeTools()` 输出 | 把 `DescribedTool[]` 嵌入 system prompt 的 `[tools]` 段；预算来自 step-15 的 5 层布局 |
| **step-16**（query engine） | `agent.ts → engine/queryEngine.ts` | 在 queryEngine 中构造 `ToolContext` 并下发；`tool.run(args, ctx)` 真传 ctx |
| **step-18**（sub-agent runtime） | `ToolContext.spawnSubAgent` | 替换占位 `SpawnFn` 为真实签名 `(req: SpawnRequest) => Promise<SubAgentHandle>` |
| **step-22**（agent UI） | `Tool.renderResult` 返回类型 | 收紧 `unknown` → `React.ReactNode`；运行时不破坏 |

---

## 8. 自检清单

- [x] `bun run typecheck`：EXIT=0
- [x] `describeTools({ budgetTokens: 100, ... })` 输出全部 `level: "lean"`
- [x] `describeTools({ budgetTokens: 5000, lastToolCalls: ['echo'] })` 输出 `level: "full"`
- [x] `describeTools({ budgetTokens: 5000, recentMessages: [unrelated], lastToolCalls: [] })` 输出 `level: "lean"`
- [x] `echoTool` 用 `desc.lean/full` + `family: "meta"` + `isReadOnly: true` + `canUseWithoutAsk: true` + `checkPermissions` 返回 allow
- [x] `registerTool(echoTool, { namespace: "meta" })` 走通；`listTools({ namespace: "meta" })` 返回 echo
- [x] `agent.ts` 兼容旧 `string` 返回 + 新 `ToolResult` 返回（`typeof raw === "string"` 分流）
- [x] `docs/protocols/tool-v2.md` 含完整字段表 / `ToolContext` / `ToolResult` / ATP / 注册 / `checkPermissions` / 兼容 / checklist / 下游 step 钩点（10 节）
- [x] 不修改 `bin/chovy.js`、`bin/chovy.js.map`
- [x] 不引入新依赖（`package.json` 未变）
- [x] 不删除 / 重构未要求的代码（`src/types/agent.ts` / `src/types/hook.ts` / `src/types/context.ts` / `src/cli/*` 全部原样）
- [x] 顶部注释 / 字段标注里明示了所有 `TODO step-XX` 衔接点（step-12 / 13 / 18 / 22 三占位接口 + `renderResult` + `describe.ts` stub）
- [x] B1 屏障接口冻结：`Tool` / `ToolContext` / `ToolResult` / `PermissionPreflight` / `DescribeOptions` / `DescribedTool` / `RegisterOptions` / `ListFilter`

---

## 9. 致谢与边界

- 灵感来源：`cc-haha/src/Tool.ts`（取其"工具自描述 + 权限预检 + 渲染分离"骨架；不复刻它 792 行的 ToolUseContext 矩阵——chovy-code 的 ATP/PCM 走的是不同路）
- 本步严格按 AGENTS.md §5 的 8 条硬规则执行；未越界修改 `~/.gitconfig` / `.git` / 构建产物 / dotfiles
- 本步严格按 `docs/innovations.md §10` 的"不做"清单：未引入 GrowthBook / Anthropic prompt cache 价格优化 / Docker 沙箱
- 未做 `git commit / push`（按规则等用户授权）

> **下一步建议**：开 step-07（Tool Budget Allocator）—— 这是 ATP 创新的真正分配算法所在。step-07 会替换 `src/tools/describe.ts` 中的 stub 函数体（**签名不变**），同时 step-08（fs tools）/ step-09（bash）/ step-10（web）/ step-11（meta）可与 step-07 **并行启动**，因为它们只依赖 step-06 已冻结的 `Tool` v2 接口，不依赖分配器的具体实现。
