import type { ProviderId } from "../types/provider.js";

export type ToolSupportMode = "native" | "json-mode" | "no";

export type ProviderFamily =
  | "gpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "glm"
  | "kimi"
  | "minimax";

export interface PricingSpec {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderCapabilitySpec {
  contextWindow: number;
  supportsStreaming: boolean;
  supportsTools: ToolSupportMode;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsParallelToolCalls: boolean;
  maxOutputTokens: number;
  pricing: PricingSpec;
  family: ProviderFamily;
}

export const CAPS: Record<ProviderId, ProviderCapabilitySpec> = {
  deepseek: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.27, out: 1.1 },
    family: "deepseek",
  },
  zai: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 0.5, out: 1.5 },
    family: "glm",
  },
  zhipu: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 0.5, out: 1.5 },
    family: "glm",
  },
  kimi: {
    contextWindow: 256_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.6, out: 2.5 },
    family: "kimi",
  },
  minimax: {
    contextWindow: 245_000,
    supportsStreaming: true,
    supportsTools: "json-mode",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.2, out: 0.8 },
    family: "minimax",
  },
  alibaba: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: false,
    maxOutputTokens: 8192,
    pricing: { in: 0.2, out: 0.6 },
    family: "gpt",
  },
  openai: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 16_384,
    pricing: { in: 0.15, out: 0.6 },
    family: "gpt",
  },
  anthropic: {
    contextWindow: 200_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 3.0, out: 15.0 },
    family: "claude",
  },
  google: {
    contextWindow: 2_000_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 1.25, out: 5.0 },
    family: "gemini",
  },
  xai: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 2.0, out: 10.0 },
    family: "gpt",
  },
  siliconflow: {
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: true,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 0.0, out: 0.0 },
    family: "gpt",
  },
  stepfun: {
    contextWindow: 256_000,
    supportsStreaming: true,
    supportsTools: "native",
    supportsVision: false,
    supportsJsonMode: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 8192,
    pricing: { in: 0.1, out: 0.3 },
    family: "gpt",
  },
};

import { loadConfig } from "../config/config.js";

export function getCapability(p: ProviderId): ProviderCapabilitySpec {
  const cap = CAPS[p];
  if (!cap) {
    throw new Error(`No capability entry for provider "${p}"`);
  }
  try {
    const config = loadConfig();
    if (config.provider === p) {
      const activeModelId = config.model;
      const customModels = config.customModels?.[p] || [];
      const customModel = customModels.find(m => m.id === activeModelId);
      if (customModel && customModel.contextWindow) {
        return { ...cap, contextWindow: customModel.contextWindow };
      }
    }
  } catch (err) {
    // Ignore config errors during early bootstrap
  }
  return cap;
}
