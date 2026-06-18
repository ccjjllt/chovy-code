import type { ChatCompletion, ChatMessage } from "./messages.js";

/** Identifiers for every provider chovy-code knows how to talk to. */
export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "minimax"
  | "glm"
  | "kimi";

/**
 * Capability matrix (PCM — Provider Capability Matrix). Declared per
 * provider in step-17 and consumed by the QueryEngine to pick a
 * degradation path when a feature is missing (e.g. no native tools →
 * fall back to JSON-mode tool emulation).
 *
 * The schema is frozen here in step-01; values land in
 * `src/providers/capabilities.ts` during step-17.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  jsonMode: boolean;
  /** Native prompt-cache awareness (e.g. Anthropic). */
  promptCache: boolean;
  /** Long context window (>= 128k tokens). */
  longContext: boolean;
  /** Maximum context window in tokens — used by SCW (step-27). */
  contextWindow: number;
}

/** Static descriptor for a provider (capabilities + default model). */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Env var name that holds the API key. */
  envKey: string;
  /** Sensible default model id. */
  defaultModel: string;
  /** True if the provider supports streaming tokens. */
  supportsStreaming: boolean;
  /** True if the provider supports tool/function calling. */
  supportsTools: boolean;
  /**
   * Full capability matrix. Optional in step-01 because the existing
   * provider scaffolds don't declare it yet; step-17 makes it required
   * across all 7 providers.
   */
  capabilities?: ProviderCapabilities;
}

/** Options passed to a provider when making a request. */
export interface ProviderRequestOptions {
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  /** Allowed tools, by name. The provider translates these into its own format. */
  tools?: string[];
  temperature?: number;
  maxTokens?: number;
  /** Optional abort signal for cancellation/timeouts. */
  signal?: AbortSignal;
}

/**
 * Every provider adapter implements this. The runtime holds a registry of
 * these keyed by ProviderId; new providers are added by implementing this
 * interface and registering in `src/providers/index.ts`.
 */
export interface Provider {
  readonly info: ProviderInfo;
  /** Validate that the provider is usable (e.g. API key present). Throws if not. */
  assertReady(): void;
  /** Perform a single completion. */
  complete(opts: ProviderRequestOptions): Promise<ChatCompletion>;
  /** Stream a completion. Yields incremental text deltas as `string` and a final ChatCompletion. */
  stream?(
    opts: ProviderRequestOptions,
  ): AsyncIterable<string | ChatCompletion>;
}

/** Aggregate type re-exports for callers. */
export type { ChatCompletion, ChatMessage } from "./messages.js";
