import { createOpenAICompatProvider, type OpenAICompatSpec } from "./openaiCompat.js";
import type { Provider, ProviderId, ProviderInfo } from "../types/provider.js";

function getBaseUrl(id: string): string {
  // Try to read custom base url from environment, otherwise fallback to defaults
  const envUrl = process.env[`${id.toUpperCase()}_BASE_URL`];
  if (envUrl) return envUrl;
  
  if (id === "deepseek") return "https://api.deepseek.com";
  if (id === "zai") return "https://api.z.ai";
  if (id === "zhipu") return "https://open.bigmodel.cn/api/paas/v4";
  if (id === "kimi") return "https://api.moonshot.cn/v1";
  if (id === "minimax") return "https://api.minimax.chat/v1";
  if (id === "alibaba") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (id === "openai") return "https://api.openai.com/v1";
  if (id === "anthropic") return "https://api.anthropic.com";
  if (id === "google") return "https://generativelanguage.googleapis.com/v1beta/openai";
  if (id === "xai") return "https://api.x.ai/v1";
  if (id === "siliconflow") return "https://api.siliconflow.cn/v1";
  if (id === "stepfun") return "https://api.stepfun.com/v1";
  return "https://api.openai.com/v1"; // Fallback
}

function getAuthHeader(_id: string, apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export function createChovyProvider(providerId: string): Provider {
  const info: ProviderInfo = {
    id: providerId as ProviderId,
    label: providerId.charAt(0).toUpperCase() + providerId.slice(1),
    envKey: `${providerId.toUpperCase()}_API_KEY`,
    defaultModel: "",
    supportsStreaming: true,
    supportsTools: true,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonMode: true,
      promptCache: false,
      longContext: true,
      contextWindow: 128000,
    },
  };

  const spec: OpenAICompatSpec = {
    info,
    baseUrl: () => getBaseUrl(providerId),
    path: "/chat/completions",
    family: "gpt",
    maxOutputTokens: 8192,
    auth: (apiKey) => getAuthHeader(providerId, apiKey),
  };

  return createOpenAICompatProvider(spec);
}

// We will register a provider instance for each group
export const chovyProviderInstances = [
  "deepseek",
  "zai",
  "zhipu",
  "kimi",
  "minimax",
  "alibaba",
  "openai",
  "anthropic",
  "google",
  "xai",
  "siliconflow",
  "stepfun",
].map((id) => createChovyProvider(id));
