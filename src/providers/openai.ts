/**
 * OpenAI adapter (step-17).
 *
 * Real implementation backed by the OpenAI-compat factory. Hits the
 * standard `/v1/chat/completions` endpoint with `Authorization: Bearer`
 * and the `gpt` SSE family. Honours `OPENAI_BASE_URL` so users can route
 * through a proxy / Azure shim without rebuilding.
 */

import type { Provider, ProviderInfo } from "../types/index.js";
import { createOpenAICompatProvider } from "./openaiCompat.js";

const INFO: ProviderInfo = {
  id: "openai",
  label: "OpenAI",
  envKey: "OPENAI_API_KEY",
  defaultModel: "gpt-4o-mini",
  supportsStreaming: true,
  supportsTools: true,
};

export const openaiProvider: Provider = createOpenAICompatProvider({
  info: INFO,
  baseUrl: () => process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
  path: "/v1/chat/completions",
  family: "gpt",
  maxOutputTokens: 16_384,
  auth: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
});
