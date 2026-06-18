# Step 17 — Providers Real（7 个 provider 真实接线 + Capability Matrix）

**Phase**: D | **依赖**: 16 | **可并行**: ❌（B3 屏障，但内部 7 个 provider 可分工） | **估时**: 10h

## 目标

把当前 6 个 scaffold provider 替换为真实可用实现，并把 OpenAI 适配器从 stub 升级到真实 fetch。
配套实现 **PCM — Provider Capability Matrix** 与降级路径。

## 产物

```
src/providers/
├── registry.ts        # 已存在
├── capabilities.ts    # 新：能力矩阵 + 单价表
├── streaming.ts       # 新：通用 SSE 解析
├── toolFormat.ts      # 新：tool schema → provider 各自格式
├── openai.ts          # 升级
├── anthropic.ts       # 真实
├── gemini.ts          # 真实
├── deepseek.ts        # 真实（OpenAI-兼容）
├── minimax.ts         # 真实
├── glm.ts             # 真实（智谱 BIGMODEL）
├── kimi.ts            # 真实（moonshot, OpenAI-兼容）
└── index.ts
```

## Capability Matrix

```ts
// capabilities.ts
export const CAPS: Record<ProviderId, ProviderCapabilities> = {
  openai: {
    contextWindow: 128_000, supportsStreaming: true,
    supportsTools: 'native', supportsVision: true,
    supportsJsonMode: true, supportsParallelToolCalls: true,
    maxOutputTokens: 16_384,
    pricing: { in: 0.15, out: 0.6 },     // /1M tokens, gpt-4o-mini 默认
    family: 'gpt',
  },
  anthropic: {
    contextWindow: 200_000, supportsStreaming: true,
    supportsTools: 'native', supportsVision: true,
    supportsJsonMode: false, supportsParallelToolCalls: true,
    maxOutputTokens: 8192, pricing: { in: 3, out: 15, cacheRead: 0.3 },
    family: 'claude',
  },
  gemini: {
    contextWindow: 1_000_000, supportsStreaming: true,
    supportsTools: 'native', supportsVision: true,
    supportsJsonMode: true, supportsParallelToolCalls: false,
    maxOutputTokens: 8192, pricing: { in: 0.075, out: 0.3 },
    family: 'gemini',
  },
  deepseek: {
    contextWindow: 128_000, supportsStreaming: true,
    supportsTools: 'native', supportsVision: false,
    supportsJsonMode: true, supportsParallelToolCalls: false,
    maxOutputTokens: 8192, pricing: { in: 0.27, out: 1.10 },
    family: 'deepseek',
  },
  glm: {
    contextWindow: 128_000, supportsStreaming: true,
    supportsTools: 'native', supportsVision: true,
    supportsJsonMode: true, supportsParallelToolCalls: true,
    maxOutputTokens: 8192, pricing: { in: 0.5, out: 1.5 },
    family: 'glm',
  },
  kimi: {
    contextWindow: 256_000, supportsStreaming: true,
    supportsTools: 'native', supportsVision: false,
    supportsJsonMode: true, supportsParallelToolCalls: false,
    maxOutputTokens: 8192, pricing: { in: 0.6, out: 2.5 },
    family: 'kimi',
  },
  minimax: {
    contextWindow: 245_000, supportsStreaming: true,
    supportsTools: 'json-mode',  // 需要降级
    supportsVision: false, supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192, pricing: { in: 0.2, out: 0.8 },
    family: 'minimax',
  },
};

export function getCapability(p: ProviderId): ProviderCapabilities;
```

## 工具格式适配

```ts
// toolFormat.ts
// 输入 DescribedTool[]; 输出 provider 自有格式
export function toOpenAITools(t: DescribedTool[]): OpenAITool[];
export function toAnthropicTools(t: DescribedTool[]): AnthropicTool[];
export function toGeminiTools(t: DescribedTool[]): GeminiFunctionDecl[];
// 对 supportsTools='json-mode' 的：注入"输出 JSON 调用"指令到 prompt + JSON schema
export function toJsonModePromptInjection(t: DescribedTool[]): string;
```

## 流式 SSE 通用解析

`streaming.ts` 提供：
- `parseSSE(stream)` → `AsyncIterable<RawEvent>`
- `mergeIntoCompletion(events, family)` → `ChatCompletion` 增量

每个 family 实现自己的 `eventToDelta(family, event)` map：
- gpt：choices[0].delta.{content|tool_calls}
- claude：content_block_delta.{type|delta}
- gemini：candidates[0].content.parts[]
- glm/kimi/deepseek：基本兼容 OpenAI

## Provider 实现规范

每个 provider 文件遵循同一骨架：

```ts
const INFO: ProviderInfo = { ... };
const URL_BASE = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';

export const openaiProvider: Provider = {
  info: INFO,
  assertReady() { if (!getSecret('openai')) throw new ChovyError('PROVIDER_NOT_READY', ...); },
  async complete(opts) { ... fetch ... return ChatCompletion },
  async *stream(opts)  { ... fetch stream:true ... yield deltas + final },
};
```

## 降级路径

QueryEngine 在调用前检查 capability：
- 工具但 `supportsTools='json-mode'` → toolFormat 注入 prompt + 解析 `<tool_use>` JSON；
- 工具但 `supportsTools='no'` → 降级"prompted" 协议；
- streaming=false → 一次性返回；UI 静默；
- json-mode 缺失但需要结构化输出 → 用 `tryFixJSON()` 容错。

## OpenAI 兼容渠道

DeepSeek / Kimi 几乎 100% OpenAI 兼容；它们的 client 直接复用 `openai.ts` 的 fetch 逻辑，仅换 base url + key。
GLM 部分接近 OpenAI（chat completions）但 tools 格式略有差异；按官方 SDK 文档对齐。

## 验收标准

- `chovy --provider openai "say hi"` 真实流式输出；
- `chovy --provider anthropic "list 3 colors as JSON" --feature jsonmode` 输出合法 JSON；
- `chovy --provider minimax "use echo tool"` 通过 json-mode 降级触发 echo 工具；
- 7 个 provider 都能跑通"echo via tool"冒烟。

## 参考源

- `cc-haha/src/services/api/`、`adapters/`（虽然 cc-haha adapters 是 IM 而非 LLM provider，但 SSE 解析有借鉴）
- 各 provider 官方 API doc（不再赘述链接）

## 风险

- 各家 SDK breaking changes → 不依赖 SDK，直接 fetch；hash 化 endpoint 路径。
- 7 路并行开发的合规质量 → 强制每个 provider 至少 1 个集成测试（mock fetch）。
