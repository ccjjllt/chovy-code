export interface ChovyModel {
  id: string;
  name: string;
  lab: string;
}

export interface ChovyProvider {
  id: string;
  name: string;
  models: ChovyModel[];
}

export const chovyProviders: Record<string, ChovyProvider> = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", lab: "DeepSeek" },
      { id: "deepseek-reasoner", name: "DeepSeek R1", lab: "DeepSeek" },
    ],
  },
  zai: {
    id: "zai",
    name: "Z.AI",
    models: [
      { id: "glm-4.7", name: "GLM-4.7", lab: "Z.ai" },
      { id: "glm-5", name: "GLM-5", lab: "Z.ai" },
      { id: "Z.AI Coding Plan", name: "Z.AI Coding Plan", lab: "Z.ai" },
    ],
  },
  zhipu: {
    id: "zhipu",
    name: "Zhipu AI",
    models: [
      { id: "glm-4-plus", name: "GLM-4 Plus", lab: "Zhipu AI" },
      { id: "Zhipu AI Coding Plan", name: "Zhipu AI Coding Plan", lab: "Zhipu AI" },
    ],
  },
  kimi: {
    id: "kimi",
    name: "Moonshot AI",
    models: [
      { id: "moonshot-v1-8k", name: "Kimi (8k)", lab: "Moonshot AI" },
      { id: "moonshot-v1-32k", name: "Kimi (32k)", lab: "Moonshot AI" },
      { id: "kimi-k2.5", name: "kimi-k2.5", lab: "Moonshot AI" },
      { id: "Kimi For Coding", name: "Kimi For Coding", lab: "Moonshot AI" },
    ],
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    models: [
      { id: "minimax-m2.1", name: "MiniMax-M2.1", lab: "MiniMax" },
      { id: "minimax-m2.5", name: "MiniMax-M2.5", lab: "MiniMax" },
      { id: "minimax-m2.7", name: "MiniMax-M2.7", lab: "MiniMax" },
      { id: "minimax-m2", name: "MiniMax-M2", lab: "MiniMax" },
    ],
  },
  alibaba: {
    id: "alibaba",
    name: "Alibaba",
    models: [
      { id: "qwen3-coder-next", name: "qwen3-coder-next", lab: "Alibaba" },
      { id: "qwen3-vl:235b-instruct", name: "qwen3-vl:235b-instruct", lab: "Alibaba" },
      { id: "qwen3-next:80b", name: "qwen3-next:80b", lab: "Alibaba" },
      { id: "qwen3-vl:235b", name: "qwen3-vl:235b", lab: "Alibaba" },
      { id: "qwen3-coder:480b", name: "qwen3-coder:480b", lab: "Alibaba" },
      { id: "qwen3.5:397b", name: "qwen3.5:397b", lab: "Alibaba" },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o", name: "GPT-4o", lab: "OpenAI" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", lab: "OpenAI" },
      { id: "o1", name: "o1", lab: "OpenAI" },
      { id: "o3-mini", name: "o3-mini", lab: "OpenAI" },
    ],
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet", lab: "Anthropic" },
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", lab: "Anthropic" },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", lab: "Anthropic" },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus", lab: "Anthropic" },
    ],
  },
  google: {
    id: "google",
    name: "Google",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", lab: "Google" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", lab: "Google" },
      { id: "gemini-2.0-pro-exp-02-05", name: "Gemini 2.0 Pro Exp", lab: "Google" },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", lab: "Google" },
    ],
  },
  xai: {
    id: "xai",
    name: "xAI",
    models: [
      { id: "grok-2-1212", name: "Grok 2", lab: "xAI" },
      { id: "grok-3", name: "Grok 3", lab: "xAI" },
    ],
  },
  siliconflow: {
    id: "siliconflow",
    name: "SiliconFlow",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", lab: "SiliconFlow" },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", lab: "SiliconFlow" },
      { id: "Qwen/Qwen2.5-Coder-32B-Instruct", name: "Qwen2.5 Coder 32B", lab: "SiliconFlow" },
      { id: "THUDM/glm-4-9b-chat", name: "GLM-4 9B Chat", lab: "SiliconFlow" },
    ],
  },
  stepfun: {
    id: "stepfun",
    name: "StepFun",
    models: [
      { id: "step-1-32k", name: "Step 1 (32K)", lab: "StepFun" },
      { id: "step-3.5-flash", name: "Step 3.5 Flash", lab: "StepFun" },
      { id: "step-2-16k", name: "Step 2 (16K)", lab: "StepFun" },
    ],
  },
};

export const popularModels: ChovyModel[] = [
  { id: "gpt-4o", name: "GPT-4o", lab: "OpenAI" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", lab: "Anthropic" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", lab: "Google" },
  { id: "deepseek-reasoner", name: "DeepSeek R1", lab: "DeepSeek" },
];

export const allChovyModels: ChovyModel[] = [
  ...Object.values(chovyProviders).flatMap((p) => p.models),
  ...popularModels,
];
