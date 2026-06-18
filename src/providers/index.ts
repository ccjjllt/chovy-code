import { registerProvider } from "./registry.js";
import { openaiProvider } from "./openai.js";
import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { deepseekProvider } from "./deepseek.js";
import { glmProvider } from "./glm.js";
import { kimiProvider } from "./kimi.js";
import { minimaxProvider } from "./minimax.js";

/**
 * Step-17 wiring.
 *
 * All seven providers ship real adapters now (the step-06 scaffolds are
 * gone). Registration order is alphabetical for stable diffs; the
 * registry uses a `Map` so order has no semantic effect.
 */

registerProvider(anthropicProvider);
registerProvider(deepseekProvider);
registerProvider(geminiProvider);
registerProvider(glmProvider);
registerProvider(kimiProvider);
registerProvider(minimaxProvider);
registerProvider(openaiProvider);

// Public surface ────────────────────────────────────────────────────────────
export { getProvider, listProviders, registerProvider, _unregisterProviderForTesting } from "./registry.js";
export { scaffoldProvider } from "./scaffold.js";
export {
  CAPS,
  getCapability,
  type ProviderCapabilitySpec,
  type ProviderFamily,
  type ToolSupportMode,
} from "./capabilities.js";
export {
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools,
  toJsonModePromptInjection,
  parseJsonModeToolCalls,
} from "./toolFormat.js";
export { parseSSE, mergeDelta, finalizeCompletion, newAccumulator } from "./streaming.js";
