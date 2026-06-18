/**
 * Zhipu GLM (BIGMODEL) adapter (step-17).
 *
 * Zhipu's GLM-4 / GLM-4.5 line ships an OpenAI-compatible chat-completions
 * endpoint at `open.bigmodel.cn/api/paas/v4/chat/completions`. The body
 * shape and SSE frames mirror OpenAI; quirks worth noting:
 *
 *   - `tool_choice` accepts `auto` / `none` / `{ type: "function", function:
 *     { name } }` — our default `"auto"` works.
 *   - GLM streams a `usage` block at the end of the stream (good).
 *   - GLM-4.5 / GLM-4.6 expose a `thinking` field; the OpenAI-family
 *     merger (`streaming.ts`) ignores unknown fields so reasoning blocks
 *     simply don't surface yet (TODO step-18).
 */

import type { Provider, ProviderInfo } from "../types/index.js";
import { createOpenAICompatProvider } from "./openaiCompat.js";

const INFO: ProviderInfo = {
  id: "glm",
  label: "Zhipu GLM",
  envKey: "GLM_API_KEY",
  defaultModel: "glm-4-plus",
  supportsStreaming: true,
  supportsTools: true,
};

export const glmProvider: Provider = createOpenAICompatProvider({
  info: INFO,
  baseUrl: () => process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas",
  path: "/v4/chat/completions",
  family: "glm",
  maxOutputTokens: 8192,
  auth: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
});
