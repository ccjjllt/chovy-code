/**
 * Google Gemini adapter (step-17).
 *
 * Talks to `generativelanguage.googleapis.com/v1beta/models/{model}:{op}`
 * directly. Two RPCs:
 *
 *   - `:generateContent`              — non-streaming completion
 *   - `:streamGenerateContent?alt=sse` — SSE streaming
 *
 * The auth token rides in the `?key=` query param; users may also point
 * `GEMINI_BASE_URL` at the AI-Studio gateway.
 *
 * Wire shape highlights:
 *   - Messages live in `contents[]` with `role: "user" | "model"` (no
 *     `system`, no `assistant`).
 *   - System instruction is a top-level `systemInstruction` field.
 *   - Tool calls are `parts[].functionCall { name, args }` blocks; tool
 *     results round-trip as `parts[].functionResponse { name, response }`.
 *   - Tool declarations: `tools: [{ functionDeclarations: [...] }]`.
 *
 * Vertex AI Service-Account auth and OAuth flows are out of scope for
 * step-17; we target the AI-Studio API-key flow only.
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
import { toGeminiTools } from "./toolFormat.js";
import {
  clampMaxTokens,
  httpJson,
  httpStream,
  resolveToolSpecs,
  trimSlash,
} from "./common.js";

const INFO: ProviderInfo = {
  id: "gemini",
  label: "Google Gemini",
  envKey: "GEMINI_API_KEY",
  defaultModel: "gemini-2.5-pro",
  supportsStreaming: true,
  supportsTools: true,
};

const MAX_OUTPUT = 8192;

function key(): string | undefined {
  return getSecret(INFO.id);
}

function baseUrl(): string {
  return process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
}

interface BuiltRequest {
  url: string;
  body: Record<string, unknown>;
}

function buildRequest(
  opts: ProviderRequestOptions,
  stream: boolean,
): BuiltRequest {
  const op = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const sep = op.includes("?") ? "&" : "?";
  const url = `${trimSlash(baseUrl())}/v1beta/models/${encodeURIComponent(opts.model)}:${op}${sep}key=${encodeURIComponent(key() ?? "")}`;

  const body: Record<string, unknown> = {
    contents: geminiContents(opts.messages),
    generationConfig: {
      maxOutputTokens: clampMaxTokens(opts.maxTokens, MAX_OUTPUT),
    },
  };
  if (typeof opts.temperature === "number") {
    (body.generationConfig as Record<string, unknown>).temperature = opts.temperature;
  }
  if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
    body.systemInstruction = {
      role: "system",
      parts: [{ text: opts.systemPrompt }],
    };
  }
  const specs = resolveToolSpecs(opts);
  if (specs.length > 0) {
    body.tools = [{ functionDeclarations: toGeminiTools(specs) }];
  }
  return { url, body };
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: unknown } }
    | { functionResponse: { name: string; response: unknown } }
  >;
}

function geminiContents(msgs: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  let lastAssistantCalls: ToolCall[] = [];
  let pendingIdx = 0;

  for (const m of msgs) {
    if (m.role === "system") continue; // hoisted to systemInstruction
    if (m.role === "user") {
      appendUser(out, [{ text: m.content ?? "" }]);
      continue;
    }
    if (m.role === "assistant") {
      const parts: GeminiContent["parts"] = [];
      if (m.content && m.content.length > 0) parts.push({ text: m.content });
      const calls = m.toolCalls ?? [];
      for (const c of calls) {
        let args: unknown = {};
        try {
          args = c.arguments ? JSON.parse(c.arguments) : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: c.name, args } });
      }
      if (parts.length === 0) parts.push({ text: "" });
      out.push({ role: "model", parts });
      lastAssistantCalls = calls;
      pendingIdx = 0;
      continue;
    }
    if (m.role === "tool") {
      const call = lastAssistantCalls[pendingIdx++];
      const name = call?.name ?? m.toolName ?? "tool";
      let response: unknown = m.content ?? "";
      // Gemini wants `response` to be an object; wrap strings.
      if (typeof response === "string") {
        try {
          response = JSON.parse(response);
        } catch {
          response = { output: response };
        }
      }
      appendUser(out, [{ functionResponse: { name, response } }]);
      continue;
    }
  }
  return out;
}

function appendUser(
  out: GeminiContent[],
  parts: GeminiContent["parts"],
): void {
  const last = out[out.length - 1];
  if (last && last.role === "user") {
    last.parts.push(...parts);
    return;
  }
  out.push({ role: "user", parts });
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: unknown };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

function parseGeminiResponse(json: GeminiResponse): ChatCompletion {
  let content = "";
  const toolCalls: ToolCall[] = [];
  const cand = json.candidates?.[0];
  for (const part of cand?.content?.parts ?? []) {
    if (typeof part.text === "string") content += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `gem_${toolCalls.length}`,
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }
  const completion: ChatCompletion = { content, toolCalls };
  if (json.usageMetadata) {
    completion.usage = {
      prompt: json.usageMetadata.promptTokenCount ?? 0,
      completion: json.usageMetadata.candidatesTokenCount ?? 0,
    };
  }
  return completion;
}

export const geminiProvider: Provider = {
  info: INFO,

  assertReady(): void {
    if (!key()) {
      throw new ChovyError(
        "PROVIDER_NOT_READY",
        `${INFO.label} API key missing. Set ${INFO.envKey} in your environment or write ~/.chovy/secrets/${INFO.id}.`,
        undefined,
        { provider: INFO.id, envKey: INFO.envKey },
      );
    }
  },

  async complete(opts: ProviderRequestOptions): Promise<ChatCompletion> {
    this.assertReady();
    const built = buildRequest(opts, false);
    const json = await httpJson<GeminiResponse>({
      url: built.url,
      headers: { "Content-Type": "application/json" },
      body: built.body,
      signal: opts.signal,
      provider: INFO.id,
    });
    return parseGeminiResponse(json);
  },

  async *stream(opts) {
    this.assertReady();
    const built = buildRequest(opts, true);
    const stream = await httpStream({
      url: built.url,
      headers: { "Content-Type": "application/json" },
      body: built.body,
      signal: opts.signal,
      provider: INFO.id,
    });
    const accum = newAccumulator();
    for await (const ev of parseSSE(stream)) {
      const out = mergeDelta("gemini", accum, ev);
      if (out.textDelta) yield out.textDelta;
      if (out.done) break;
    }
    yield finalizeCompletion(accum);
  },
};
