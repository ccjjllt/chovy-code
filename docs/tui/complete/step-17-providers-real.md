# Step 17 — Providers Real 验收报告

> 范围：`docs/step-17-providers-real.md`（Phase D，依赖 16；B3 屏障）。
> 把 6 个 scaffold provider 替换为真实可用实现，OpenAI 适配器从 stub
> 升级到真实 fetch；同步落地 PCM（Provider Capability Matrix）+ 通用 SSE
> 解析 + 工具格式适配（含 json-mode 降级）。

## 1. 产物清单

```
src/providers/
├── registry.ts          # （沿用 step-01）
├── scaffold.ts          # 仍保留，仅作 fallback / 工厂示例
├── capabilities.ts      # 新：PCM 7 行 × 9 维 + getCapability
├── streaming.ts         # 新：parseSSE（CRLF / 分块 / [DONE]）+ 4 family merge
├── toolFormat.ts        # 新：toOpenAITools / toAnthropicTools / toGeminiTools
│                        #     + toJsonModePromptInjection + parseJsonModeToolCalls
├── common.ts            # 新：resolveToolSpecs / httpJson / httpStream / 错误包装
├── openaiCompat.ts      # 新：5 个 OpenAI 兼容 provider 的工厂
├── openai.ts            # 升级：走工厂；`gpt` family
├── deepseek.ts          # 真实：`deepseek` family（OpenAI 兼容）
├── kimi.ts              # 真实：`kimi` family（OpenAI 兼容，moonshot.cn）
├── glm.ts               # 真实：`glm` family（智谱 BIGMODEL /v4 路径）
├── minimax.ts           # 真实：`minimax` family + json-mode 工具降级
├── anthropic.ts         # 真实：直写 Messages API（content blocks）
├── gemini.ts            # 真实：直写 generateContent / streamGenerateContent
└── index.ts             # 注册全部 7 个真实 provider；导出 PCM / streaming / toolFormat
```

`src/types/provider.ts` 追加可选字段 `ProviderToolSpec` + `ProviderRequestOptions.toolSpecs?`，
QueryEngine 以此把 ATP 已选 lean/full 直接交给 provider，避免重新分配。

## 2. 主要改动 / 单源约定

| 维度 | 落地 |
|---|---|
| 7 provider 真实接线 | OpenAI / DeepSeek / GLM / Kimi / MiniMax 走 `openaiCompat` 工厂；Anthropic / Gemini 各自直写 |
| PCM 单源 | `src/providers/capabilities.ts` 定义 `ProviderCapabilitySpec`（contextWindow / supportsTools='native'\|'json-mode'\|'no' / supportsVision / supportsJsonMode / supportsParallelToolCalls / maxOutputTokens / pricing / family） |
| SSE 单源 | `src/providers/streaming.ts` 提供 `parseSSE` + `mergeDelta(family,...)`；4 family merger（gpt / claude / gemini / 通用 OpenAI 兼容）共享一份累加器 |
| Tool 格式单源 | `src/providers/toolFormat.ts` 一份 zod-schema → 各家原生格式（OpenAI / Anthropic / Gemini）+ json-mode `<tool_use>` envelope 注入与回收 |
| HTTP 错误归一 | `common.ts` 把非 2xx 包成 `ChovyError(PROVIDER_API_ERROR / PROVIDER_RATE_LIMIT)`，meta 带 provider/url/status/bodySnippet |
| AbortSignal 透传 | `httpJson` / `httpStream` 把 `signal` 直接交给 fetch；上游 streamHandler 的 abort 透传到底 |

## 3. PCM 表（capabilities.ts）

| Provider | ctx | supportsTools | parallel | maxOut | $/1M in→out | family |
|---|---:|---|:-:|---:|---:|---|
| openai | 128k | native | ✓ | 16 384 | 0.15 → 0.6 | gpt |
| anthropic | 200k | native | ✓ | 8 192 | 3 → 15 (cacheRead 0.3) | claude |
| gemini | 1 000k | native | ✗ | 8 192 | 0.075 → 0.3 | gemini |
| deepseek | 128k | native | ✗ | 8 192 | 0.27 → 1.10 | deepseek |
| glm | 128k | native | ✓ | 8 192 | 0.5 → 1.5 | glm |
| kimi | 256k | native | ✗ | 8 192 | 0.6 → 2.5 | kimi |
| minimax | 245k | **json-mode** | ✗ | 8 192 | 0.2 → 0.8 | minimax |

`getCapability(p)` 在未知 id 时直接 throw（"fast & loud"，避免静默漂移）。

## 4. 工具格式适配

- `toOpenAITools`：`[{ type:"function", function:{ name, description, parameters } }]`，DeepSeek / Kimi / GLM / OpenAI 都走这条；
- `toAnthropicTools`：`[{ name, description, input_schema }]`；
- `toGeminiTools`：剥除 `$schema / $defs / additionalProperties / 不支持的 format` 后 `[{ name, description, parameters }]`，外层 `tools:[{ functionDeclarations:[...] }]`；
- `toJsonModePromptInjection`：把工具列表追加到 system prompt，要求模型用 `<tool_use>{"name":..,"arguments":..}</tool_use>` 包裹工具调用；
- `parseJsonModeToolCalls(content)`：从 assistant 文本里把 envelope 抠出来，组装成 `ToolCall[]`，返回剥离后的纯文本 + 调用列表（每次循环复位 `lastIndex`，符合 AGENTS.md §16 通配/正则不变量）。

## 5. 流式 SSE（streaming.ts）

- `parseSSE(stream)`：单 reader、跨 chunk 缓冲、CRLF/LF 兼容；自动跳过 `:` 注释、`[DONE]` 终止迭代；末尾 chunk 缺少空行也能取出最后一帧；
- `mergeDelta(family, accum, raw)`：
  - **gpt / deepseek / glm / kimi / minimax**：`choices[0].delta.{content|tool_calls[]}`，按 `index|id` 累加 tool call args；
  - **claude**：`message_start` / `content_block_start(tool_use)` / `content_block_delta(text_delta|input_json_delta)` / `message_delta(usage)` / `message_stop`；
  - **gemini**：`candidates[0].content.parts[].{text|functionCall}` + `usageMetadata`；
- `finalizeCompletion(accum)`：把累积器折叠成 `ChatCompletion`；用于 stream 收尾或非流式路径。

## 6. 验收清单（对应 step-17 §验收 + 风险）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | `chovy --provider openai "say hi"` 真实流式输出 | ✅（mock）| `scripts/smoke-step17.ts` 第 6 段 SSE 流式回放 → openai stream() 拼出 "Hello world" |
| 2 | `chovy --provider anthropic --feature jsonmode` 输出合法 JSON | ✅（mock）| Messages API content blocks 流式 + 非流式分别可解析 |
| 3 | `chovy --provider minimax "use echo tool"` 通过 json-mode 降级触发 echo | ✅ | smoke 第 5 段：minimax 返回 `<tool_use>` envelope，`parseJsonModeToolCalls` 还原成 `echo({"message":"hi"})` |
| 4 | 7 provider 都跑通 "echo via tool" 冒烟 | ✅ | smoke 第 5 段对 OpenAI / DeepSeek / Kimi / GLM / MiniMax / Anthropic / Gemini 各 mock 一次 → 全部命中 |
| 5 | typecheck | ✅ | `bun run typecheck` → 0 errors |
| 6 | 风险：每个 provider 至少 1 个 mock-fetch 集成测试 | ✅ | smoke-step17.ts 共 36 项断言全部通过（PCM 8 + SSE 3 + merger 9 + toolFormat 6 + 7 provider 7 + 流式 3） |

## 7. 与 step-16 / 16-下游的边界

- QueryEngine `reqOpts` 现在同时下发 `tools: string[]`（向后兼容）和 `toolSpecs: ProviderToolSpec[]`（ATP 已选 lean/full + JSON schema）；provider 优先消费 `toolSpecs`，缺席时 `resolveToolSpecs` 回查 registry 用 lean 默认。
- `messageNormalize.ts` 行为不变：在 engine 侧先做 reasoning 剥离、孤儿 tool 修剪、tool 输出裁剪，再交给 provider；provider 端的 wire 转换专注于 *形状*（OpenAI flat / Anthropic content-blocks / Gemini parts），不再做内容净化。
- AbortSignal：`runStream(signal)` → `provider.stream({...,signal})` → `httpStream({...,signal})` → `fetch({signal})` → `parseSSE(reader)`；任意一步 abort，下游 reader 会立刻 reject（fetch AbortError 由 wrapNetwork 转抛，不被包裹）。
- 错误归一：上层捕到 `PROVIDER_API_ERROR` / `PROVIDER_RATE_LIMIT` 即可走 step-16 的早退路径（`stopReason='final'` + 写入 `chovy.error: <CODE>`）。

## 8. 不变量（追加进 AGENTS.md §16/17 的候选条目）

- **PCM 单源**：`src/providers/capabilities.ts` 是 7 provider 能力 + 价格的唯一权威；`engine/costTracker.ts` 的 `DEFAULT_PRICES` 与 PCM `pricing` 字段保持一致（数值偏离请 PR 时同步修改两处）。
- **SSE 单源**：`parseSSE` 是 chovy-code 唯一的 SSE 解析器；新 provider 接入时只需声明 `family` 并在 `mergeDelta` 中加一个 case，不得另写解析器。
- **Tool 格式单源**：`toolFormat.ts` 把 zod→JSON schema→各家原生工具格式收敛在一处；provider 内部不允许直接 `Object.entries(zodSchema)` 自行转换。
- **`toolSpecs` 优于 `tools: string[]`**：当 `toolSpecs` 非空时，provider **必须**消费它（即 ATP 已选的 lean/full）；否则才回查 registry 默认 lean。
- **fetch AbortError 透传**：`common.wrapNetwork` 对 `AbortError` 直接 rethrow，不包装成 `PROVIDER_API_ERROR`，确保 step-16 的取消语义不被遮蔽。
- **MiniMax json-mode 降级路径冻结**：`<tool_use>{"name":..,"arguments":..}</tool_use>` envelope；同时：① system prompt 注入由 `toJsonModePromptInjection` 统一产生；② 流式路径在还原前不向 UI 转发原始 token（避免 envelope 漏出）；③ 解析端永远兜底（envelope 非法即丢弃，模型回退成纯文本）。
- **OpenAI 兼容广播**：DeepSeek / Kimi / GLM / MiniMax 都通过 `createOpenAICompatProvider` 工厂构造；增加新 OpenAI 兼容渠道时优先走工厂，不要复制粘贴 fetch 代码。
- **Auth header 边界**：每个 provider 的 `auth(apiKey)` 是构造 header 的唯一入口（OpenAI/DeepSeek/GLM/Kimi/MiniMax 都用 `Authorization: Bearer`，Anthropic 用 `x-api-key`，Gemini 走 `?key=`），不允许在 `complete/stream` 内联手写。

## 9. 后续步骤（B3 屏障 ✅）

step-17 完成意味着 B3 屏障落地，进入 Phase E（子智能体 / SwarmR / Judge）：

- step-18 子 agent 运行时直接 `new QueryEngine().run({ provider, model, agentRole, toolAllowlist, abortSignal })`；
- step-20 SwarmR 的 fan-out 调度可用 PCM `family` / `pricing` / `contextWindow` 来决定哪些子任务派发到长上下文 provider；
- step-21 裁判模型默认走 `glm-4-plus / kimi 256k / deepseek-chat`，PCM 的 `contextWindow` ≥ 128k 是筛选条件；
- step-27/28 SCW 直接读 PCM `contextWindow` 推算 softLimit / hardLimit，不再硬编码；
- 真实 provider key 在用户环境就绪后即可跑端到端：`OPENAI_API_KEY=... bun run start "say hi"`。
