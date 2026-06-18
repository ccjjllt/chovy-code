/**
 * Anthropic adapter (step-17).
 *
 * Talks to the Messages API (`/v1/messages`) directly via fetch — no SDK
 * dependency. The wire shape diverges enough from OpenAI that we don't
 * route through the `openaiCompat` factory:
 *
 *   - System prompt is a top-level `system` field, not a message.
 *   - Assistant turns carry `content` as an array of blocks (`text` or
 *     `tool_use`); user turns carry `tool_result` blocks for tool output.
 *   - Tool call ids round-trip via `tool_use_id`; we map our flat
 *     ChatMessage tool-result list onto the most recent assistant
 *     `tool_use` blocks the same way the OpenAI adapter does.
 *   - Streaming uses named SSE events (`message_start`, `content_block_*`,
 *     `message_delta`, `message_stop`) — handled by the `claude` family
 *     in `streaming.ts`.
 *
 * Headers: `x-api-key` plus `anthropic-version: 2023-06-01`. Beta features
 * (prompt caching, tool use) live behind `anthropic-beta` headers when
 * the user opts in via env (see `ANTHROPIC_BETA`).
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
import { toAnthropicTools } from "./toolFormat.js";
import {
  clampMaxTokens,
  httpJson,
  httpStream,
  resolveToolSpecs,
  trimSlash,
} from "./common.js";

const INFO: ProviderInfo = {
  id: "anthropic",
  label: "Anthropic Claude",
  envKey: "ANTHROPIC_API_KEY",
  defaultModel: "claude-sonnet-4-5",
  supportsStreaming: true,
  supportsTools: true,
};

const MAX_OUTPUT = 8192;

function key(): string | undefined {
  return getSecret(INFO.id);
}

function baseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": key() ?? "",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  if (process.env.ANTHROPIC_BETA) headers["anthropic-beta"] = process.env.ANTHROPIC_BETA;
  return headers;
}

interface BuiltRequest {
  url: string;
  body: Record<string, unknown>;
}

function buildRequest(opts: ProviderRequestOptions, stream: boolean): BuiltRequest {
  const url = `${trimSlash(baseUrl())}/v1/messages`;
  const messages = anthropicMessages(opts.messages);
  const specs = resolveToolSpecs(opts);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    max_tokens: clampMaxTokens(opts.maxTokens, MAX_OUTPUT),
    stream,
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
    body.system = opts.systemPrompt;
  }
  if (specs.length > 0) {
    body.tools = toAnthropicTools(specs);
  }
  return { url, body };
}

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: string }
  >;
}

/**
 * Convert chovy's flat ChatMessage[] into Anthropic's content-block layout.
 *
 *   - chovy `system` → consumed by `body.system` (filtered out here)
 *   - chovy `user` → `{role:'user', content:[{type:'text', text}]}`
 *   - chovy `assistant` → text block + one tool_use per `toolCalls[]`
 *   - chovy `tool` → user-turn `tool_result` block paired with the
 *     most recent assistant `tool_use` id
 *
 * Adjacent user-role messages (which happen because every tool result is
 * its own ChatMessage) are merged into a single user turn so Anthropic's
 * "alternate user/assistant" rule isn't violated.
 */
function anthropicMessages(msgs: ChatMessage[]): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  let lastAssistantCalls: ToolCall[] = [];
  let pendingIdx = 0;

  for (const m of msgs) {
    if (m.role === "system") continue; // hoisted to body.system
    if (m.role === "user") {
      appendUser(out, [{ type: "text", text: m.content ?? "" }]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicWireMessage["content"] = [];
      if (m.content && m.content.length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      const calls = m.toolCalls ?? [];
      for (const c of calls) {
        let input: unknown = {};
        try {
          input = c.arguments ? JSON.parse(c.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      out.push({ role: "assistant", content: blocks });
      lastAssistantCalls = calls;
      pendingIdx = 0;
      continue;
    }
    if (m.role === "tool") {
      const call = lastAssistantCalls[pendingIdx++];
      const id = call?.id ?? `tool_${pendingIdx}`;
      appendUser(out, [
        { type: "tool_result", tool_use_id: id, content: m.content ?? "" },
      ]);
      continue;
    }
  }
  return out;
}

function appendUser(
  out: AnthropicWireMessage[],
  blocks: AnthropicWireMessage["content"],
): void {
  const last = out[out.length - 1];
  if (last && last.role === "user") {
    last.content.push(...blocks);
    return;
  }
  out.push({ role: "user", content: blocks });
}

interface AnthropicResponse {
  content?: Array<
    | { type: "text"; text?: string }
    | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  >;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function parseAnthropicResponse(json: AnthropicResponse): ChatCompletion {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `tool_${toolCalls.length}`,
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const completion: ChatCompletion = { content, toolCalls };
  if (json.usage) {
    completion.usage = {
      prompt: json.usage.input_tokens ?? 0,
      completion: json.usage.output_tokens ?? 0,
    };
  }
  return completion;
}

export const anthropicProvider: Provider = {
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
    const json = await httpJson<AnthropicResponse>({
      url: built.url,
      headers: authHeaders(),
      body: built.body,
      signal: opts.signal,
      provider: INFO.id,
    });
    return parseAnthropicResponse(json);
  },

  async *stream(opts) {
    this.assertReady();
    const built = buildRequest(opts, true);
    const stream = await httpStream({
      url: built.url,
      headers: authHeaders(),
      body: built.body,
      signal: opts.signal,
      provider: INFO.id,
    });
    const accum = newAccumulator();
    for await (const ev of parseSSE(stream)) {
      const out = mergeDelta("claude", accum, ev);
      if (out.textDelta) yield out.textDelta;
      if (out.done) break;
    }
    yield finalizeCompletion(accum);
  },
};
