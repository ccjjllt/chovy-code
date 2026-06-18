import { registerProvider } from "./registry.js";
import { openaiProvider } from "./openai.js";
import { scaffoldProvider } from "./scaffold.js";

// --- Register every known provider --------------------------------------
// Real adapters (like openaiProvider) implement the wire protocol.
// Scaffold adapters below are placeholders to be replaced one-by-one.

registerProvider(openaiProvider);

registerProvider(
  scaffoldProvider({
    id: "anthropic",
    label: "Anthropic Claude",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
  }),
);

registerProvider(
  scaffoldProvider({
    id: "gemini",
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-pro",
  }),
);

registerProvider(
  scaffoldProvider({
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  }),
);

registerProvider(
  scaffoldProvider({
    id: "minimax",
    label: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    defaultModel: "abab6.5s-chat",
  }),
);

registerProvider(
  scaffoldProvider({
    id: "glm",
    label: "Zhipu GLM",
    envKey: "GLM_API_KEY",
    defaultModel: "glm-4-plus",
  }),
);

registerProvider(
  scaffoldProvider({
    id: "kimi",
    label: "Moonshot Kimi",
    envKey: "KIMI_API_KEY",
    defaultModel: "moonshot-v1-32k",
  }),
);

// Re-export the registry accessors for convenience.
export { getProvider, listProviders } from "./registry.js";
export { scaffoldProvider } from "./scaffold.js";
