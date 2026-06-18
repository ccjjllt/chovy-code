import type {
  ChatCompletion,
  Provider,
  ProviderInfo,
  ProviderRequestOptions,
} from "../types/index.js";
import { getSecret } from "../config/secrets.js";
import { ChovyError } from "../types/errors.js";

/**
 * Factory that produces a *scaffold* provider for the providers whose wire
 * protocol we haven't implemented yet. Every adapter produced here:
 *   - declares the correct ProviderInfo (label, env key, default model)
 *   - validates its API key in `assertReady`
 *   - returns a clearly-marked "not implemented" completion
 *
 * Swap each one out for a real adapter (see `openai.ts`) as you wire it up,
 * and remove it from the list below.
 */

interface Spec {
  id: ProviderInfo["id"];
  label: string;
  envKey: string;
  defaultModel: string;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
}

export function scaffoldProvider(spec: Spec): Provider {
  const info: ProviderInfo = {
    id: spec.id,
    label: spec.label,
    envKey: spec.envKey,
    defaultModel: spec.defaultModel,
    supportsStreaming: spec.supportsStreaming ?? true,
    supportsTools: spec.supportsTools ?? true,
  };

  return {
    info,

    assertReady(): void {
      if (!getSecret(info.id)) {
        throw new ChovyError(
          "PROVIDER_NOT_READY",
          `${info.label} API key missing. Set ${info.envKey} in your environment or write ~/.chovy/secrets/${info.id}.`,
          undefined,
          { provider: info.id, envKey: info.envKey },
        );
      }
    },

    async complete(opts: ProviderRequestOptions): Promise<ChatCompletion> {
      this.assertReady();
      const model = opts.model ?? info.defaultModel;
      void opts;
      return {
        content: `[${info.id}:${model}] provider.complete() not yet implemented`,
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
}
