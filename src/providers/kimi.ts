/**
 * Kimi (Moonshot) adapter (step-17).
 *
 * Moonshot's `/v1/chat/completions` is OpenAI-compatible — same body, same
 * SSE shape, same tool-call schema. The only practical differences are
 * the base URL (`api.moonshot.cn/v1`) and the longer context window
 * (128k / 256k SKUs). We reuse the OpenAI-compat factory.
 */

import type { Provider, ProviderInfo } from "../types/index.js";
import { createOpenAICompatProvider } from "./openaiCompat.js";

const INFO: ProviderInfo = {
  id: "kimi",
  label: "Moonshot Kimi",
  envKey: "KIMI_API_KEY",
  defaultModel: "moonshot-v1-32k",
  supportsStreaming: true,
  supportsTools: true,
};

export const kimiProvider: Provider = createOpenAICompatProvider({
  info: INFO,
  // Moonshot's docs use api.moonshot.cn/v1; the path includes /v1 already
  // so we hand in the bare host and append /v1/chat/completions.
  baseUrl: () => process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn",
  path: "/v1/chat/completions",
  family: "kimi",
  maxOutputTokens: 8192,
  auth: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
});
