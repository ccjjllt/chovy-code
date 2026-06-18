/**
 * DeepSeek adapter (step-17).
 *
 * DeepSeek's chat API (`api.deepseek.com/v1/chat/completions`) is a
 * near-identical clone of OpenAI's — same body, same SSE shape. We reuse
 * the OpenAI-compat factory verbatim. Models: `deepseek-chat`,
 * `deepseek-reasoner` (the latter streams a `reasoning_content` field
 * the merger ignores until step-18 wires reasoning blocks).
 */

import type { Provider, ProviderInfo } from "../types/index.js";
import { createOpenAICompatProvider } from "./openaiCompat.js";

const INFO: ProviderInfo = {
  id: "deepseek",
  label: "DeepSeek",
  envKey: "DEEPSEEK_API_KEY",
  defaultModel: "deepseek-chat",
  supportsStreaming: true,
  supportsTools: true,
};

export const deepseekProvider: Provider = createOpenAICompatProvider({
  info: INFO,
  baseUrl: () => process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  path: "/v1/chat/completions",
  family: "deepseek",
  maxOutputTokens: 8192,
  auth: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
});
