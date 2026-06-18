# Phase A-D 复验报告

> 复验日期：2026-06-18
> 范围：Phase A（step-01–05）/ Phase B（step-06–11）/ Phase C（step-12–14）/ **Phase D（step-15–17，新覆盖）**
> 结论：Phase A-D 全部通过复验；本轮发现并修复 2 个跨 step 隐患（P1：`queryEngine.ts` 体量越界；P2：PCM 单源声明与 `costTracker.PROVIDER_DEFAULTS` 数值漂移）。可进入 Phase E（step-18 Sub-Agent Runtime）。

---

## 1. 复验依据

- `docs/README.md`、`docs/architecture.md`、`docs/innovations.md`
- `docs/protocols/tool-v2.md`
- `docs/step-01-types-and-error-model.md` → `docs/step-17-providers-real.md`
- `docs/complete/` 下 step-01～14 完成报告 + `phase-a-c-acceptance.md` + `step-15-system-prompt.md` + `step-16-acceptance.md` + `step-17-providers-real.md`
- `AGENTS.md`（§5 红线 / §8 风格 / §15-§16 不变量）
- `源码解析.md`（cc-haha 第三章 systemPrompt + cache-break / 第四/五章 provider 适配 + QueryEngine）
- `D:/Desktop/cc-haha-main/`：仅吸收 5 层 prompt 模型 + boundary + perToolHash + SSE 解析模式 + 工具格式分家思路；**未**复刻 `cache_control` 计费、`promptCacheBreakDetection` 727 行 BQ 事件家族、914 行内部 prompt、GrowthBook 缓存 strategy、Buddy / KAIROS / 语音模式。

---

## 2. 本轮发现并修复的问题

| ID | 问题 | 影响 | 修复 |
|---|---|---|---|
| **P1** | `src/engine/queryEngine.ts` 783 行（实测），违反 `docs/step-16-query-engine.md §风险`"≤ 600 行"硬限 + AGENTS.md §8 单文件上限 | 文件膨胀，违反 spec；后续 SCW（step-27/28）插入将进一步推高 | 抽取 `executeToolCall` + `invokeTool` 到 `src/engine/toolExecutor.ts`（250 行），主文件回到 **566 行**。新增 `engine→toolExecutor` 单向依赖，无循环。 |
| **P2** | step-17 §8 声明"PCM 单源；`costTracker.DEFAULT_PRICES` 与 PCM `pricing` 保持一致"，实测 `PROVIDER_DEFAULTS` 与 `CAPS.pricing` 5/7 个 provider 数值漂移（openai 0.5/1.5 vs 0.15/0.6；gemini 1.25/5 vs 0.075/0.3；glm 0.7/2.2 vs 0.5/1.5；kimi 1.7/1.7 vs 0.6/2.5；minimax 0.28/0.28 vs 0.2/0.8） | "single source" 流于注释；任何价格 PR 改一处忘改另一处即静默漂移 | 把 `PROVIDER_DEFAULTS` 改为 IIFE **结构性派生**自 `CAPS.pricing`（含 cacheRead/cacheWrite 透传）。今后改 PCM 自动同步，无须双改。AGENTS.md §17 把这条固化为"PCM 单源"代码化不变量。 |

两个修复都以**最小改动**落地，未触碰任何冻结接口（`Tool`/`ToolContext`/`ToolResult` / `QueryRunOptions` / `Provider.complete-stream` / `BuildOptions` / `EffectivePrompt` / `PromptShape` / `ProviderCapabilitySpec`）。

---

## 3. 实测命令

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | **PASS**（0 errors） |
| `bun run scripts/smoke-step-04.ts` | PASS，20 项 |
| `bun run scripts/smoke-step07.ts` | PASS，6 个 ATP case，`tools.described` 6 事件 |
| `bun run scripts/smoke-fs-tools.ts` | PASS，16 项 |
| `bun run scripts/smoke-step09.ts` | PASS，25 项 |
| `bun run scripts/smoke-step10.ts` | PASS，14 项 |
| `bun run scripts/smoke-step11.ts` | PASS，45 项 |
| `bun run scripts/smoke-step12.ts` | PASS，20 项 |
| `bun run scripts/smoke-step13.ts` | PASS，38 项 |
| `bun run scripts/smoke-step14.ts` | PASS，46 项（Windows 沙箱 PATH 大小写已固化在 §16） |
| `bun run scripts/smoke-step15.ts` | PASS，27 项（plan note / override 短路 / staticHash 稳定 / perToolHash diff） |
| `bun run scripts/smoke-step17.ts` | PASS，36 项（PCM 8 + SSE 3 + merger 9 + toolFormat 6 + 7 provider × 1 + 流式 3） |
| `bun run scripts/smoke-phase-b-acceptance.ts` | PASS，11 项 |
| `bun run build` | PASS（`bin/chovy.js`，**700.9 KB**） |
| `bun bin/chovy.js --version` | `0.1.0` |
| `bun bin/chovy.js provider list` | 7 真实 provider 列表正常（anthropic / deepseek / gemini / glm / kimi / minimax / openai） |

step-16 没有专属 smoke 脚本（spec 要求"旧 runAgent 用例继续通过"——由 `phase-b-acceptance` 与 build/CLI 烟雾覆盖）。**前后两次跑全套冒烟均 PASS**——P1/P2 修复未引入任何回归。

> 真实 provider 网络 E2E 与 `WebFetch` 在线 example.com 测试需用户提供 API key + `SMOKE_NETWORK=1`，本轮未触发。step-17 §6 已用 mock-fetch 集成测试覆盖 7 provider 的 `complete` / `stream` 形状。

---

## 4. 接口与不变量确认

### 4.1 跨 phase 接口冻结面（未破坏）

- `Tool` / `ToolContext` / `ToolResult`（B1）：未触碰；agent loop 仍负责构造 ctx 并下发 `tool.run(args, ctx)`。
- `PermissionMode` / `HookEvent` / `AgentRole` / `SystemPromptLayer` / `PromptShape`：单源未动；下游仅 `import type` re-export。
- `QueryRunOptions` / `QueryRunResult` / `StopReason`（B2）：仅做内部重构，公共字段未改动。
- `Provider.complete` / `Provider.stream` / `ProviderRequestOptions`（B3）：`toolSpecs?` 字段、PCM 表、SSE 解析、toolFormat 适配全部按 step-17 报告冻结。

### 4.2 telemetry 单源（未破坏）

| 事件 | 单源位置 | 验证 |
|---|---|---|
| `tool.call` | `engine/toolExecutor.ts`（重构后从 queryEngine 转移到此，仍是**唯一**发射点） | `phase-b-acceptance`"exactly one tool.call emitted per agent-loop bash call" 通过 |
| `prompt.shape` | `engine/queryEngine.ts:run()` 每轮一次 | smoke-step15 #3、#4 间接验证 PSF 字段 |
| `agent.cost` | `engine/costTracker.ts:record()` | 派生自 PCM 后语义不变；smoke 路径下 cost 事件成本表与 PCM 同源 |
| `agent.start` / `agent.end` | `engine/queryEngine.ts:run()` 入口 / finally | build-CLI 路径下命中 |
| `tools.described` | `tools/describe.ts` 内部 | smoke-step07 计 6 事件 |
| `hook.run` | `harness/hooks/engine.ts` | smoke-step13 38 项 |

### 4.3 5 层 prompt + PSF 不变量

- override 短路其它 4 层（验收 #2 通过）
- 同 cwd 同 plan-mode staticHash 稳定（验收 #3 通过）
- 工具描述变化仅 perToolHash 漂移、toolsHash 不变（验收 #4 通过）
- plan-mode 翻转必改 staticHash（设计反向断言通过）

### 4.4 provider 不变量

- PCM 7 行 × 9 维 + `getCapability` "fast & loud" 抛错（smoke-step17 #1 段验证）
- 通用 SSE：`parseSSE` CRLF / 跨 chunk / `[DONE]` / 末尾无空行（smoke-step17 #3 段）
- 4 family merge：gpt / claude / gemini / 通用 OpenAI 兼容（smoke-step17 #4 段）
- MiniMax json-mode 降级：`<tool_use>` envelope 单源；流式不漏 token（smoke-step17 #5 段）
- 7 provider mock-fetch 集成 echo via tool（smoke-step17 #5 段，全部命中）
- AbortSignal 透传链：`runStream → provider.stream → httpStream → fetch → parseSSE`，AbortError 不被 `wrapNetwork` 包装

### 4.5 体量

| 文件 | 行数 | 上限 | 状态 |
|---|---:|---:|---|
| `src/engine/queryEngine.ts` | **566** | 600 | ✅（修复前 783 ❌） |
| `src/engine/toolExecutor.ts` | 250 | 600 | ✅（新文件） |
| `src/engine/costTracker.ts` | 234 | 600 | ✅ |
| `src/engine/streamHandler.ts` | 125 | 600 | ✅ |
| `src/engine/messageNormalize.ts` | 147 | 600 | ✅ |
| `src/providers/streaming.ts` | 461 | 600 | ✅ |
| `src/providers/openaiCompat.ts` | 314 | 600 | ✅ |

---

## 5. 修复审计

### 5.1 P1：queryEngine 拆分

```
src/engine/
├── queryEngine.ts        566 行（原 783）— 主循环 / 取消 / fillBuildOptions / runPreflight / resolveToolPool / makeAgentId
└── toolExecutor.ts       250 行（新增）— executeToolCall + invokeTool（pure helpers，无 engine 状态）
```

调用替换：`this.executeToolCall(...)` → `executeToolCall(...)`；`this.invokeTool(...)` → `invokeTool(...)`（在 toolExecutor 内部互调）。  
导入清理：从 queryEngine.ts 移除 `ZodType` / `ToolCall` 直接依赖；toolExecutor.ts 接管这些。  
telemetry 单源：`tool.call` 事件仍在唯一发射点（不再是 queryEngine wrapper，而是 toolExecutor wrapper），`phase-b-acceptance` "exactly one tool.call" 用例通过证明无双发。

### 5.2 P2：CostTracker PCM 单源

```ts
// engine/costTracker.ts —— 修复前
const PROVIDER_DEFAULTS: Record<ProviderId, ModelPrice> = {
  openai: { inputPerMTok: 0.5, outputPerMTok: 1.5 },     // ❌ 与 CAPS 不一致
  gemini: { inputPerMTok: 1.25, outputPerMTok: 5 },      // ❌ 与 CAPS 不一致
  // …
};

// 修复后：结构性派生
const PROVIDER_DEFAULTS: Record<ProviderId, ModelPrice> = (() => {
  const out = {} as Record<ProviderId, ModelPrice>;
  for (const [id, cap] of Object.entries(CAPS) as Array<[ProviderId, (typeof CAPS)[ProviderId]]>) {
    out[id] = {
      inputPerMTok: cap.pricing.in,
      outputPerMTok: cap.pricing.out,
      ...(cap.pricing.cacheRead  !== undefined ? { cacheReadPerMTok:  cap.pricing.cacheRead  } : {}),
      ...(cap.pricing.cacheWrite !== undefined ? { cacheWritePerMTok: cap.pricing.cacheWrite } : {}),
    };
  }
  return out;
})();
```

- 依赖方向：`engine/costTracker.ts` import `providers/capabilities.ts`（叶子直达，无循环）。
- DEFAULT_PRICES（per-model）仍保留——SKU 级覆盖与 provider 兜底是两层关注点；二者不再倒挂。
- 行为变化：未配置 model 时 unit cost 与 PCM 一致（之前 openai 兜底 0.5/1.5，现在 0.15/0.6）。这是**bug 修复**，不是行为破坏：调用方 `cost.total()` 可能获得更精确的数值。

---

## 6. 文档同步

| 文件 | 改动 |
|---|---|
| `AGENTS.md §1`（首段） | "Phase A-C 已完成 → 进入 D" 改为 "Phase A-D 已完成 → 进入 E"（next milestone：step-18 Sub-Agent Runtime） |
| `AGENTS.md §3`（仓库现状） | 目录树补 `agent/`（runAgent shim）、`engine/`（QueryEngine 套件）、`prompts/`（5 层 + boundary + PSF）；providers 改"7 真实 + PCM + SSE + toolFormat"；已具备/未实现分类按 Phase D 完成更新 |
| `AGENTS.md §17`（**新增**） | Phase D 不变量集合：单源规约（SystemPromptLayer / PromptShape / PCM / SSE / toolFormat）、冻结接口（BuildOptions / QueryRunOptions / Provider.complete-stream + toolSpecs）、telemetry 单源（prompt.shape / agent.cost / agent.start-end）、5 层 prompt 不变量、PSF 不变量、取消信号不变量、provider 真实接线不变量、queryEngine.ts ≤600 行约束、engine→providers 边 |
| `docs/README.md §0` | 状态从"Phase A-C"升到"Phase A-D"；目录树补 engine/prompts；新增 phase-a-d 报告链接 |
| `docs/complete/phase-a-d-acceptance.md`（**新增**） | 本文件 |

`docs/complete/phase-a-c-acceptance.md` 保留为历史快照，未删除；新报告引用旧报告作为基线。

---

## 7. 当前边界

**已完成**：
- Phase A：类型/错误模型、配置/secrets/features、logger/telemetry、safeFs/chovy home、CLI/REPL 骨架。
- Phase B：Tool Protocol v2、ATP 分配器、fs/exec/web/meta 9 个核心工具。
- Phase C：6 层权限引擎、12 事件 hook 引擎、文件系统/命令沙箱。
- **Phase D：5 层 system prompt + 静态/动态分区 + PSF；QueryEngine 主循环 + costTracker（PCM 派生）+ streamHandler + messageNormalize + toolExecutor；7 真实 provider + PCM + 通用 SSE + toolFormat（含 MiniMax json-mode 降级）。**

**未实现**（按原路线进入后续 Phase）：
- Phase E：子 Agent 运行时（lifecycle / id / cancel / costUSD）+ 内置 4 子 agent（explore / plan / verify / critic）+ SwarmR + Judge + Agent UI。
- Phase F：`/goal` 长程任务循环（Stop hook + 收敛判据）。
- Phase G：bun:sqlite + FTS5 + 4 类记忆 + checkpoint-writer 子 agent。
- Phase H：SCW（自动 checkpoint 触发 + 上下文重建 + 预算化注入）。
- Phase I：CSG 技能图 + 端到端集成。

**B1 / B2 / B3 屏障状态**：✅ 全部落地。step-18 可以直接 `new QueryEngine().run({ provider, model, agentRole, toolAllowlist, abortSignal })` 派生子 agent，无须再动 engine 表面。

---

## 8. 工作树注意

- 复验前已存在未跟踪 `nul` 文件，本轮未删除、未修改。
- 本轮未触碰 `bin/chovy.js` / `bin/chovy.js.map` 之外的构建产物；构建产物在 `bun run build` 中重新生成。
- 未引入新依赖；`package.json` 未变。
