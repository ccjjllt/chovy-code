/**
 * OpenAI-compatible adapter factory (step-17).
 *
 * OpenAI shipped the de-facto chat-completions wire format in 2023 and
 * five of the seven chovy-code providers honour it (with optional quirks):
 * OpenAI itself, DeepSeek, Kimi (Moonshot), GLM (智谱 BIGMODEL), and
 * MiniMax. Rather than copy-paste the same fetch/SSE code five times we
 * factor it out here. Concrete adapters supply:
 *
 *   - `info`                — ProviderInfo (id, label, env key, default model)
 *   - `baseUrl()`           — endpoint override (env-driven)
 *   - `path`                — usually `/v1/chat/completions`; minimax uses
 *                             a different one
 *   - `family`              — the `streaming.ts` family used to merge SSE
 *                             deltas. Most are `gpt`-shaped; only minimax /
 *                             glm / deepseek / kimi need their own family
 *                             because of cost/usage-field quirks
 *   - `auth(apiKey)`        — produces the `Authorization` / custom-key
 *                             header(s)
 *   - `transformBody?`      — last-mile mutation (e.g. minimax's
 *                             tool degradation, glm's optional tool_choice)
 *   - `injectJsonModeTools?`— when true, the factory rewrites `tools`
 *                             into a system-prompt addendum and parses
 *                             `<tool_use>` envelopes back out of the
 *                             assistant content for the QueryEngine.
 *
 * The factory honours the `Provider` interface — both `complete()` (one
 * shot) and `stream()` (SSE) — and forwards `signal` so abort flows
 * through the underlying `fetch`.
 */

import {
  type ChatCompletion,
  type ChatMessage,
  type Provider,
  type ProviderInfo,
  type ProviderRequestOptions,
  type ToolCall,
} from "../types/index.js";
import { ChovyError } from "../types/errors.js";
import { getSecret } from "../config/secrets.js";
import {
  finalizeCompletion,
  mergeDelta,
  newAccumulator,
  parseSSE,
} from "./streaming.js";
import type { ProviderFamily } from "./capabilities.js";
import {
  parseJsonModeToolCalls,
  toJsonModePromptInjection,
  toOpenAITools,
} from "./toolFormat.js";
import {
  clampMaxTokens,
  httpJson,
  httpStream,
  resolveToolSpecs,
  trimSlash,
} from "./common.js";

export interface OpenAICompatSpec {
  info: ProviderInfo;
  /** Resolves the base URL from env / config. Called per request. */
  baseUrl(): string;
  /** Path appended to baseUrl, e.g. `/v1/chat/completions`. */
  path: string;
  family: ProviderFamily;
  /** Per-call output-token cap; clamped against `opts.maxTokens`. */
  maxOutputTokens: number;
  /**
   * When true, native tool calling is unavailable: we strip `tools` from
   * the body, append a `<tool_use>` system-prompt addendum, and parse
   * envelopes back out of the assistant text.
   */
  injectJsonModeTools?: boolean;
  /** Build the auth headers (Authorization or X-Api-Key, etc.). */
  auth(apiKey: string): Record<string, string>;
  /**
   * Last-mile body transform — e.g. provider-specific stream usage flags.
   * Receives the *fully built* body and may mutate or replace fields.
   */
  transformBody?(body: Record<string, unknown>): Record<string, unknown>;
}

interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** When true, the response carries `<tool_use>` envelopes to recover. */
  jsonMode: boolean;
}

export function createOpenAICompatProvider(spec: OpenAICompatSpec): Provider {
  const id = spec.info.id;
  return {
    info: spec.info,

    assertReady(): void {
      if (!getSecret(id)) {
        throw new ChovyError(
          "PROVIDER_NOT_READY",
          `${spec.info.label} API key missing. Set ${spec.info.envKey} in your environment or write ~/.chovy/secrets/${id}.`,
          undefined,
          { provider: id, envKey: spec.info.envKey },
        );
      }
    },

    async complete(opts: ProviderRequestOptions): Promise<ChatCompletion> {
      this.assertReady();
      const built = buildRequest(spec, opts, /* stream */ false);
      const json = await httpJson<OpenAIChatResponse>({
        url: built.url,
        headers: built.headers,
        body: built.body,
        signal: opts.signal,
        provider: id,
      });
      return parseOpenAIChatResponse(json, built.jsonMode);
    },

    async *stream(opts) {
      this.assertReady();
      const built = buildRequest(spec, opts, /* stream */ true);
      const stream = await httpStream({
        url: built.url,
        headers: built.headers,
        body: built.body,
        signal: opts.signal,
        provider: id,
      });
      const accum = newAccumulator();
      for await (const ev of parseSSE(stream)) {
        const out = mergeDelta(spec.family, accum, ev);
        if (out.textDelta && !built.jsonMode) yield out.textDelta;
        if (out.done) break;
      }
      let final = finalizeCompletion(accum);
      if (built.jsonMode) {
        // Recover envelopes from the streamed text and emit text once
        // (we've been suppressing deltas because the model is mid-emitting
        // a tool_use envelope; surfacing those raw would confuse the UI).
        const recovered = parseJsonModeToolCalls(final.content);
        final = {
          ...final,
          content: recovered.text,
          toolCalls: [...final.toolCalls, ...recovered.toolCalls],
        };
        if (recovered.text) yield recovered.text;
      }
      yield final;
    },
  };
}

// ---------------------------------------------------------------------------
// Body / response shaping
// ---------------------------------------------------------------------------

function buildRequest(
  spec: OpenAICompatSpec,
  opts: ProviderRequestOptions,
  stream: boolean,
): BuiltRequest {
  const apiKey = getSecret(spec.info.id) ?? "";
  const url = `${trimSlash(spec.baseUrl())}${spec.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    ...spec.auth(apiKey),
  };

  const messages = openaiMessages(opts);
  const specs = resolveToolSpecs(opts);
  const useJsonMode = !!spec.injectJsonModeTools && specs.length > 0;

  // System prompt: prepend as a `system` message. JSON-mode degradation
  // appends the tool-use addendum to it.
  const systemText = useJsonMode
    ? `${opts.systemPrompt ?? ""}${toJsonModePromptInjection(specs)}`
    : opts.systemPrompt;
  if (systemText && systemText.trim().length > 0) {
    messages.unshift({ role: "system", content: systemText });
  }

  let body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature,
    max_tokens: clampMaxTokens(opts.maxTokens, spec.maxOutputTokens),
    stream,
  };
  if (stream) {
    body.stream_options = { include_usage: true };
  }
  if (specs.length > 0 && !useJsonMode) {
    body.tools = toOpenAITools(specs);
    body.tool_choice = "auto";
  }

  if (spec.transformBody) body = spec.transformBody(body);

  return { url, headers, body, jsonMode: useJsonMode };
}

interface OpenAIWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/**
 * Convert chovy ChatMessages into OpenAI's wire shape. Tool-result
 * messages collapse into `role: "tool"` with `tool_call_id` derived from
 * the most recent assistant `toolCalls` (since the engine doesn't track
 * id pairs explicitly today).
 */
function openaiMessages(opts: ProviderRequestOptions): OpenAIWireMessage[] {
  const out: OpenAIWireMessage[] = [];
  // Track the most-recent assistant tool calls so we can pair tool results.
  const pending: ToolCall[] = [];
  let pendingIdx = 0;
  for (const m of opts.messages) {
    if (m.role === "assistant") {
      pending.length = 0;
      pendingIdx = 0;
      const tc = m.toolCalls ?? [];
      for (const c of tc) pending.push(c);
      const wire: OpenAIWireMessage = {
        role: "assistant",
        content: m.content ?? "",
      };
      if (tc.length > 0) {
        wire.tool_calls = tc.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      }
      out.push(wire);
      continue;
    }
    if (m.role === "tool") {
      const call = pending[pendingIdx++];
      out.push({
        role: "tool",
        content: m.content ?? "",
        tool_call_id: call?.id ?? `tool_${pendingIdx}`,
        name: m.toolName,
      });
      continue;
    }
    out.push({ role: m.role, content: m.content ?? "" });
  }
  return out;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function parseOpenAIChatResponse(
  json: OpenAIChatResponse,
  jsonMode: boolean,
): ChatCompletion {
  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? "";
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map(
    (c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }),
  );
  let finalContent = content;
  let finalCalls = toolCalls;
  if (jsonMode) {
    const rec = parseJsonModeToolCalls(content);
    finalContent = rec.text;
    finalCalls = [...toolCalls, ...rec.toolCalls];
  }
  const completion: ChatCompletion = {
    content: finalContent,
    toolCalls: finalCalls,
  };
  if (json.usage) {
    completion.usage = {
      prompt: json.usage.prompt_tokens ?? 0,
      completion: json.usage.completion_tokens ?? 0,
    };
  }
  return completion;
}

// Re-export ChatMessage so adapters that need to construct one don't have
// to pull it from a third location.
export type { ChatMessage };
