/**
 * Shared helpers used by every provider adapter (step-17).
 *
 * Centralises three concerns that would otherwise be copy-pasted across
 * seven adapters:
 *
 *   1. **Tool-spec resolution.** When the caller hands in `toolSpecs` (the
 *      step-17 additive field on `ProviderRequestOptions`) we use them
 *      verbatim — that's the post-ATP description picked by the engine.
 *      When the caller only supplies `tools: string[]` (older callers,
 *      sub-agents that haven't been ported) we look each name up in the
 *      tool registry and synthesize a lean spec on the fly.
 *
 *   2. **HTTP envelope.** Every provider hits a JSON `POST` with an
 *      auth header, a JSON body, and (optionally) `stream: true`. The
 *      `httpJson` / `httpStream` wrappers take care of: serialising the
 *      body, threading `signal`, mapping non-2xx into `PROVIDER_API_ERROR`
 *      / `PROVIDER_RATE_LIMIT`, and returning either parsed JSON or the
 *      raw `ReadableStream<Uint8Array>` for SSE.
 *
 *   3. **Error wrapping.** Adapters call `wrapNetwork` so `fetch` failures
 *      surface as a `ChovyError(code: 'PROVIDER_API_ERROR', meta:{...})`
 *      with provider id + endpoint + status — the harness logger prints
 *      these in its canonical format.
 *
 * Every helper here is pure / stateless. Providers compose them; they do
 * not own request-level concerns themselves.
 */

import { ChovyError } from "../types/errors.js";
import type {
  ProviderId,
  ProviderRequestOptions,
  ProviderToolSpec,
} from "../types/provider.js";
import { getTool } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// Tool-spec resolution
// ---------------------------------------------------------------------------

/**
 * Materialise the runtime tool specs for a request. Honours `toolSpecs`
 * first (post-ATP); otherwise looks each name up in the registry and uses
 * the lean description. Unknown names are skipped with no error — the
 * QueryEngine already validated tool names earlier.
 */
export function resolveToolSpecs(
  opts: ProviderRequestOptions,
): ProviderToolSpec[] {
  if (opts.toolSpecs && opts.toolSpecs.length > 0) {
    return opts.toolSpecs;
  }
  if (!opts.tools || opts.tools.length === 0) return [];
  const out: ProviderToolSpec[] = [];
  for (const name of opts.tools) {
    const t = getTool(name);
    if (!t) continue;
    const description = t.desc?.lean ?? t.description ?? "";
    const schema = t.schema as unknown as { toJSON?: () => unknown };
    const schemaJson = schema.toJSON?.() ?? { type: "object" };
    out.push({ name: t.name, description, schemaJson, level: "lean" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP envelope
// ---------------------------------------------------------------------------

export interface HttpJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Provider id used in error metadata. */
  provider: ProviderId;
}

/**
 * `POST <url>` with a JSON body, expect a JSON response. Maps 4xx/5xx
 * into `ChovyError`. The body is `await response.text()` first so we can
 * include it in the error meta when JSON parsing fails.
 */
export async function httpJson<T = unknown>(
  opts: HttpJsonOptions,
): Promise<T> {
  const res = await wrapNetwork(opts.provider, opts.url, () =>
    fetch(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    }),
  );
  const text = await res.text();
  if (!res.ok) throw apiError(opts.provider, opts.url, res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ChovyError(
      "PROVIDER_API_ERROR",
      `Provider ${opts.provider} returned non-JSON response`,
      err,
      {
        provider: opts.provider,
        url: opts.url,
        status: res.status,
        bodySnippet: text.slice(0, 256),
      },
    );
  }
}

/**
 * `POST <url>` with a JSON body, expect an SSE stream. Returns the raw
 * `ReadableStream<Uint8Array>` so adapters can pipe through the shared
 * `parseSSE` helper.
 */
export async function httpStream(
  opts: HttpJsonOptions,
): Promise<ReadableStream<Uint8Array>> {
  const res = await wrapNetwork(opts.provider, opts.url, () =>
    fetch(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    }),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw apiError(opts.provider, opts.url, res.status, text);
  }
  if (!res.body) {
    throw new ChovyError(
      "PROVIDER_API_ERROR",
      `Provider ${opts.provider} streaming response had no body`,
      undefined,
      { provider: opts.provider, url: opts.url, status: res.status },
    );
  }
  return res.body;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

async function wrapNetwork(
  provider: ProviderId,
  url: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    // AbortError surfaces as DOMException with name 'AbortError'.
    const name = (err as { name?: string })?.name;
    if (name === "AbortError") throw err;
    throw new ChovyError(
      "PROVIDER_API_ERROR",
      `Provider ${provider} fetch failed: ${(err as Error)?.message ?? String(err)}`,
      err,
      { provider, url },
    );
  }
}

function apiError(
  provider: ProviderId,
  url: string,
  status: number,
  body: string,
): ChovyError {
  const code = status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_API_ERROR";
  return new ChovyError(
    code,
    `Provider ${provider} returned HTTP ${status}`,
    undefined,
    {
      provider,
      url,
      status,
      bodySnippet: body.slice(0, 512),
    },
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * Trim trailing slashes from a base URL. Adapters do
 * `${trimSlash(base)}/v1/chat/completions` to be tolerant of users setting
 * `OPENAI_BASE_URL=https://api.openai.com/`.
 */
export function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Cap maxTokens at the provider's documented per-call limit. */
export function clampMaxTokens(
  request: number | undefined,
  cap: number,
): number {
  if (typeof request !== "number" || !Number.isFinite(request) || request <= 0) {
    return cap;
  }
  return Math.min(request, cap);
}
