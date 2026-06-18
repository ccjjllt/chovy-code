/**
 * MiniMax adapter (step-17).
 *
 * MiniMax's abab series ships a `/v1/text/chatcompletion_v2` endpoint that
 * is structurally OpenAI-compatible (same `messages`, same `delta` SSE
 * shape) but lacks reliable native function calling. Per `capabilities.ts`
 * we set `supportsTools: 'json-mode'` and degrade tool calling by
 * injecting a `<tool_use>` envelope into the system prompt, then parsing
 * the assistant text back out. Everything else (streaming, auth, body)
 * follows the OpenAI-compat factory verbatim.
 *
 * Group ID: MiniMax sometimes requires a `GroupId` query param; we read
 * it from `MINIMAX_GROUP_ID` and append it when set, otherwise rely on
 * the API key carrying the group binding.
 */

import type { Provider, ProviderInfo } from "../types/index.js";
import { createOpenAICompatProvider } from "./openaiCompat.js";

const INFO: ProviderInfo = {
  id: "minimax",
  label: "MiniMax",
  envKey: "MINIMAX_API_KEY",
  defaultModel: "abab6.5s-chat",
  supportsStreaming: true,
  supportsTools: true,
};

const PATH_BASE = "/v1/text/chatcompletion_v2";

export const minimaxProvider: Provider = createOpenAICompatProvider({
  info: INFO,
  baseUrl: () => process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat",
  // Append GroupId when present; the OpenAI-compat factory pastes
  // baseUrl + path verbatim so a query string here is fine.
  path: process.env.MINIMAX_GROUP_ID
    ? `${PATH_BASE}?GroupId=${encodeURIComponent(process.env.MINIMAX_GROUP_ID)}`
    : PATH_BASE,
  family: "minimax",
  maxOutputTokens: 8192,
  injectJsonModeTools: true,
  auth: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
});
