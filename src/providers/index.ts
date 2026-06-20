import { registerProvider } from "./registry.js";
import { chovyProviderInstances } from "./chovyProvider.js";

/**
 * Step-17 wiring - migrated to Chovy providers.
 */

for (const provider of chovyProviderInstances) {
  registerProvider(provider);
}

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
export { chovyProviders, allChovyModels, popularModels } from "./chovyModels.js";
