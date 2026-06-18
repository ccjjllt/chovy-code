/**
 * Streaming completion handler (step-16).
 *
 * Wraps a provider's `stream()` AsyncIterable into a single-pass loop that:
 *   1. forwards each text delta to `onToken` (UI),
 *   2. accumulates the final `ChatCompletion` (last yielded non-string),
 *   3. honors `abortSignal`: closes the iterator early on abort and rolls
 *      up whatever was streamed so far so the caller can return a
 *      cancellation result rather than throwing.
 *
 * Why a separate module:
 *   - Each provider yields chunks slightly differently (string deltas vs
 *     {type: "text"} blocks vs SSE frames). Step-17 normalizes those into
 *     `string | ChatCompletion` at the provider boundary; this file is
 *     the single consumer of that union.
 *   - Cancellation is fiddly: AsyncIterable doesn't have a portable cancel
 *     primitive, so we rely on the provider observing `opts.signal` and
 *     stopping the underlying fetch. We *also* break out of our local
 *     `for await` loop to prevent spinning if the provider is sluggish.
 *
 * Today the only provider that streams is the OpenAI scaffold (which just
 * yields one delta + one completion). The interface is shaped so step-17
 * can drop in real SSE without touching the engine.
 */

import type {
  ChatCompletion,
  Provider,
  ProviderRequestOptions,
} from "../types/provider.js";

export interface StreamOutcome {
  completion: ChatCompletion;
  /** Concatenated text deltas observed during the stream. */
  streamedText: string;
  /** True when the run aborted before the provider yielded a completion. */
  aborted: boolean;
}

export interface StreamHandlerOptions {
  /** Called for every text delta (e.g. UI typewriter). */
  onToken?(delta: string): void;
  /**
   * External abort signal. When triggered, we stop iterating and assemble
   * a synthetic `ChatCompletion` from whatever text accumulated so far.
   */
  abortSignal?: AbortSignal;
}

/**
 * Run a streaming completion. Falls back to non-streaming when the
 * provider doesn't implement `stream`.
 *
 * On normal completion the provider is expected to yield text deltas as
 * `string` and a final `ChatCompletion` last; we read the last non-string
 * yielded value as the completion. If a provider only ever yields strings
 * (older scaffolds), we synthesize a completion from the buffered text.
 */
export async function runStream(
  provider: Provider,
  reqOpts: ProviderRequestOptions,
  handlers: StreamHandlerOptions = {},
): Promise<StreamOutcome> {
  const signal = handlers.abortSignal;

  // Forward our signal to the provider via the request options so it can
  // wire it into the underlying fetch. Both fast and streaming paths use
  // the wrapped options — earlier iterations only wired it on the streaming
  // branch, which left non-streaming sub-agents (step-18) unable to cancel.
  const reqWithSignal: ProviderRequestOptions = signal
    ? { ...reqOpts, signal }
    : reqOpts;

  // Non-streaming fast path.
  if (!provider.stream || !handlers.onToken) {
    try {
      const completion = await provider.complete(reqWithSignal);
      return {
        completion,
        streamedText: "",
        aborted: signal?.aborted ?? false,
      };
    } catch (err) {
      // Aborted fetches usually surface as AbortError / DOMException; the
      // engine's loop then sees `aborted: true` and unwinds via the
      // cancelled stop reason. Anything else is rethrown for the engine
      // to wrap or surface.
      if (signal?.aborted) {
        return {
          completion: synthesize(""),
          streamedText: "",
          aborted: true,
        };
      }
      throw err;
    }
  }

  // Streaming path.
  let streamedText = "";
  let final: ChatCompletion | undefined;

  try {
    for await (const chunk of provider.stream(reqWithSignal)) {
      if (signal?.aborted) break;
      if (typeof chunk === "string") {
        streamedText += chunk;
        try {
          handlers.onToken(chunk);
        } catch {
          // A misbehaving onToken handler must not break the stream.
        }
      } else {
        final = chunk;
      }
    }
  } catch (err) {
    // If we aborted, swallow the consequent AbortError; otherwise rethrow.
    if (signal?.aborted) {
      return {
        completion: synthesize(streamedText),
        streamedText,
        aborted: true,
      };
    }
    throw err;
  }

  if (signal?.aborted) {
    return {
      completion: final ?? synthesize(streamedText),
      streamedText,
      aborted: true,
    };
  }

  if (!final) final = synthesize(streamedText);
  return { completion: final, streamedText, aborted: false };
}

function synthesize(content: string): ChatCompletion {
  return { content, toolCalls: [] };
}
