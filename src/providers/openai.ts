import type {
  ChatCompletion,
  Provider,
  ProviderInfo,
  ProviderRequestOptions,
} from "../types/index.js";
import { getSecret } from "../config/secrets.js";
import { ChovyError } from "../types/errors.js";

/**
 * Reference OpenAI adapter. This is a thin scaffold: it wires up the
 * ProviderInfo and validates the API key, leaving the actual network call
 * to be filled in. The shape demonstrates the contract every adapter
 * follows, so the other six providers can be modelled on it.
 *
 * TODO: implement `complete` against POST /v1/chat/completions, and
 *       `stream` against the same endpoint with stream:true.
 */
const INFO: ProviderInfo = {
  id: "openai",
  label: "OpenAI",
  envKey: "OPENAI_API_KEY",
  defaultModel: "gpt-4o-mini",
  supportsStreaming: true,
  supportsTools: true,
};

function key(): string | undefined {
  return getSecret(INFO.id);
}

export const openaiProvider: Provider = {
  info: INFO,

  assertReady(): void {
    if (!key()) {
      throw new ChovyError(
        "PROVIDER_NOT_READY",
        `OpenAI API key missing. Set ${INFO.envKey} in your environment or write ~/.chovy/secrets/${INFO.id}.`,
        undefined,
        { provider: INFO.id, envKey: INFO.envKey },
      );
    }
  },

  async complete(opts: ProviderRequestOptions): Promise<ChatCompletion> {
    this.assertReady();
    const model = opts.model ?? INFO.defaultModel;
    // TODO: fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com"}/v1/chat/completions`, ...)
    void opts;
    return {
      content: `[openai:${model}] provider.complete() not yet implemented`,
      toolCalls: [],
    };
  },

  async *stream(opts) {
    this.assertReady();
    const completion = await this.complete(opts);
    yield completion.content;
    yield completion;
  },
};
