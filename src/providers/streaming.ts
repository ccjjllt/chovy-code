/**
 * Generic SSE plumbing + per-family delta merger (step-17).
 *
 * Every modern LLM provider ships some flavour of SSE-over-HTTP. The
 * line-level format is identical (`data: <json>\n\n` framed by blank
 * lines, optional `event: <name>` prefix) but each provider encodes
 * deltas in its own JSON shape. This module:
 *
 *   1. Implements `parseSSE(stream)` — a single, per-spec SSE parser that
 *      emits `RawEvent { event?: string; data: string }` objects to the
 *      caller. `[DONE]` from OpenAI-family endpoints is treated as
 *      end-of-stream and never yielded.
 *
 *   2. Implements `mergeDelta(family, accum, raw)` — a tiny state machine
 *      that folds a `RawEvent` into an in-progress `ChatCompletion`. Each
 *      provider's adapter calls this in its `for await` loop; the adapter
 *      itself remains thin (just fetch + auth headers + endpoint).
 *
 * Why one shared merger:
 *   - Tool-call streaming is the gnarly bit: OpenAI fragments
 *     `tool_calls[i].function.{name,arguments}` across many deltas; we
 *     have to coalesce them into a single `ToolCall`. Anthropic streams
 *     `tool_use` blocks via `content_block_*` events with `input_json_delta`
 *     fragments. Gemini emits one `functionCall` with the full args at
 *     content-block boundaries. Centralising the merge keeps adapters
 *     boring and lets us regression-test all three from one harness.
 *   - The same merger handles non-tool text deltas — the adapter only
 *     needs to know which `family` it belongs to.
 *
 * The output is a `MergeOutcome { textDelta, completionDelta, done }`
 * tuple; the adapter forwards `textDelta` to its `onToken` (yielded as a
 * `string`) and yields `completionDelta` (the freshly assembled
 * `ChatCompletion`) once on `done`. Usage tokens come from the family-
 * specific `final_*`-shaped event when the upstream sends it.
 */

import type { ChatCompletion, ToolCall } from "../types/index.js";
import type { ProviderFamily } from "./capabilities.js";

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/** One raw, parsed-but-unstructured SSE event. */
export interface RawEvent {
  /** `event:` field; absent when the upstream omits it (OpenAI / Gemini). */
  event?: string;
  /** Concatenated `data:` lines (already joined by `\n`). */
  data: string;
}

const DEC = new TextDecoder();

/**
 * Read a `ReadableStream<Uint8Array>` and yield one `RawEvent` per
 * blank-line-terminated SSE chunk. Robust against:
 *   - chunks split mid-line (we keep a leftover buffer);
 *   - CRLF line endings;
 *   - leading colons (`:` keep-alive comments — skipped);
 *   - the OpenAI `[DONE]` sentinel (terminates iteration).
 *
 * The parser is *deliberately* loose about the data field — providers may
 * ship raw JSON, multiple `data:` lines (joined per spec), or pre-encoded
 * base64. We hand the joined string off to the family merger and let the
 * provider-specific code decide.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<RawEvent> {
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += DEC.decode(value, { stream: true });

      // SSE events are separated by a blank line. Some servers use \r\n.
      let sep: number;
      while ((sep = indexOfBlankLine(buffer)) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");
        const ev = parseEventBlock(chunk);
        if (!ev) continue;
        if (ev.data === "[DONE]") return;
        yield ev;
      }
    }
    // Flush any trailing event (some servers omit the final blank line).
    const tail = buffer.trim();
    if (tail.length > 0) {
      const ev = parseEventBlock(tail);
      if (ev && ev.data !== "[DONE]") yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore — already cancelled */
    }
  }
}

function indexOfBlankLine(s: string): number {
  // Match \n\n or \r\n\r\n. Return the index of the first \n in the pair.
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === "\n" && s[i + 1] === "\n") return i + 1;
    if (
      s[i] === "\r" &&
      s[i + 1] === "\n" &&
      i + 3 < s.length &&
      s[i + 2] === "\r" &&
      s[i + 3] === "\n"
    ) {
      return i + 3;
    }
  }
  return -1;
}

function parseEventBlock(block: string): RawEvent | null {
  const lines = block.split(/\r?\n/);
  let event: string | undefined;
  const datas: string[] = [];
  for (const raw of lines) {
    if (!raw || raw.startsWith(":")) continue; // keep-alive / comment
    const ci = raw.indexOf(":");
    const field = ci === -1 ? raw : raw.slice(0, ci);
    let value = ci === -1 ? "" : raw.slice(ci + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") datas.push(value);
    // ignore `id` / `retry` per spec.
  }
  if (datas.length === 0 && !event) return null;
  return { event, data: datas.join("\n") };
}

// ---------------------------------------------------------------------------
// Per-family delta merger
// ---------------------------------------------------------------------------

/** Accumulator threaded through `mergeDelta` calls within one stream. */
export interface MergeAccumulator {
  /** Concatenated text content. */
  content: string;
  /** Tool calls assembled so far, keyed by upstream id/index. */
  toolCalls: Map<string, ToolCall & { argFrags: string[] }>;
  /** Stable order in which tool calls were first seen. */
  toolOrder: string[];
  /** Family-specific scratch (e.g. Anthropic content-block index → toolKey). */
  scratch: Record<string, unknown>;
  /** Token usage if the upstream reports it inline. */
  usage?: { prompt: number; completion: number };
  /** Set once the upstream signals end-of-message. */
  finished: boolean;
}

export function newAccumulator(): MergeAccumulator {
  return {
    content: "",
    toolCalls: new Map(),
    toolOrder: [],
    scratch: {},
    finished: false,
  };
}

/** Outcome of a single merge step — text to forward + done flag. */
export interface MergeOutcome {
  textDelta: string;
  done: boolean;
}

/**
 * Fold one `RawEvent` into the accumulator. Returns the text delta the
 * adapter should yield to the caller (empty string when the event was
 * tool-call metadata or a non-text block).
 *
 * Unknown shapes are tolerated — we never throw on a bad event, since one
 * malformed line shouldn't kill the whole stream. The adapter is responsible
 * for catching JSON parse errors at the boundary and continuing.
 */
export function mergeDelta(
  family: ProviderFamily,
  accum: MergeAccumulator,
  raw: RawEvent,
): MergeOutcome {
  switch (family) {
    case "gpt":
    case "deepseek":
    case "glm":
    case "kimi":
    case "minimax":
      return mergeOpenAIFamily(accum, raw);
    case "claude":
      return mergeClaudeFamily(accum, raw);
    case "gemini":
      return mergeGeminiFamily(accum, raw);
    default:
      return { textDelta: "", done: false };
  }
}

/** Build a `ChatCompletion` snapshot from the current accumulator. */
export function finalizeCompletion(accum: MergeAccumulator): ChatCompletion {
  const toolCalls: ToolCall[] = accum.toolOrder.map((key) => {
    const t = accum.toolCalls.get(key)!;
    return {
      id: t.id,
      name: t.name,
      arguments: t.argFrags.join("") || t.arguments || "",
    };
  });
  const completion: ChatCompletion = {
    content: accum.content,
    toolCalls,
  };
  if (accum.usage) completion.usage = accum.usage;
  return completion;
}

// ---------------------------------------------------------------------------
// Family: OpenAI / DeepSeek / GLM / Kimi / MiniMax (chat.completions stream)
// ---------------------------------------------------------------------------

function mergeOpenAIFamily(
  accum: MergeAccumulator,
  raw: RawEvent,
): MergeOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.data);
  } catch {
    return { textDelta: "", done: false };
  }
  const obj = payload as {
    choices?: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  if (obj.usage) {
    accum.usage = {
      prompt: obj.usage.prompt_tokens ?? 0,
      completion: obj.usage.completion_tokens ?? 0,
    };
  }

  const choice = obj.choices?.[0];
  if (!choice) return { textDelta: "", done: false };

  let textDelta = "";
  const delta = choice.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) {
      accum.content += delta.content;
      textDelta = delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const key = String(part.index ?? part.id ?? accum.toolOrder.length);
        let cur = accum.toolCalls.get(key);
        if (!cur) {
          cur = {
            id: part.id ?? `call_${accum.toolOrder.length}`,
            name: part.function?.name ?? "",
            arguments: "",
            argFrags: [],
          };
          accum.toolCalls.set(key, cur);
          accum.toolOrder.push(key);
        }
        if (part.id && !cur.id) cur.id = part.id;
        if (part.function?.name && !cur.name) cur.name = part.function.name;
        if (part.function?.arguments) cur.argFrags.push(part.function.arguments);
      }
    }
  }

  const done = !!choice.finish_reason;
  if (done) accum.finished = true;
  return { textDelta, done };
}

// ---------------------------------------------------------------------------
// Family: Anthropic (messages SSE — content_block_delta + tool_use)
// ---------------------------------------------------------------------------

interface ClaudeScratch {
  blockIndexToTool?: Record<number, string>;
}

function mergeClaudeFamily(
  accum: MergeAccumulator,
  raw: RawEvent,
): MergeOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.data);
  } catch {
    return { textDelta: "", done: false };
  }
  const ev = (raw.event ?? (payload as { type?: string }).type) ?? "";
  const scratch = (accum.scratch as ClaudeScratch);
  if (!scratch.blockIndexToTool) scratch.blockIndexToTool = {};

  if (ev === "content_block_start") {
    const p = payload as {
      index?: number;
      content_block?: {
        type?: string;
        id?: string;
        name?: string;
      };
    };
    const block = p.content_block;
    if (block?.type === "tool_use" && p.index !== undefined) {
      const key = block.id ?? `tu_${p.index}`;
      scratch.blockIndexToTool[p.index] = key;
      accum.toolCalls.set(key, {
        id: block.id ?? key,
        name: block.name ?? "",
        arguments: "",
        argFrags: [],
      });
      accum.toolOrder.push(key);
    }
    return { textDelta: "", done: false };
  }

  if (ev === "content_block_delta") {
    const p = payload as {
      index?: number;
      delta?: { type?: string; text?: string; partial_json?: string };
    };
    const d = p.delta;
    if (!d) return { textDelta: "", done: false };
    if (d.type === "text_delta" && typeof d.text === "string") {
      accum.content += d.text;
      return { textDelta: d.text, done: false };
    }
    if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
      const key =
        p.index !== undefined ? scratch.blockIndexToTool[p.index] : undefined;
      if (key) {
        const cur = accum.toolCalls.get(key);
        if (cur) cur.argFrags.push(d.partial_json);
      }
    }
    return { textDelta: "", done: false };
  }

  if (ev === "message_delta") {
    const p = payload as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (p.usage) {
      accum.usage = {
        prompt: p.usage.input_tokens ?? accum.usage?.prompt ?? 0,
        completion: p.usage.output_tokens ?? accum.usage?.completion ?? 0,
      };
    }
    return { textDelta: "", done: false };
  }

  if (ev === "message_start") {
    const p = payload as {
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    if (p.message?.usage) {
      accum.usage = {
        prompt: p.message.usage.input_tokens ?? 0,
        completion: p.message.usage.output_tokens ?? 0,
      };
    }
    return { textDelta: "", done: false };
  }

  if (ev === "message_stop") {
    accum.finished = true;
    return { textDelta: "", done: true };
  }

  return { textDelta: "", done: false };
}

// ---------------------------------------------------------------------------
// Family: Gemini (streamGenerateContent?alt=sse)
// ---------------------------------------------------------------------------

function mergeGeminiFamily(
  accum: MergeAccumulator,
  raw: RawEvent,
): MergeOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.data);
  } catch {
    return { textDelta: "", done: false };
  }
  const obj = payload as {
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
  };

  if (obj.usageMetadata) {
    accum.usage = {
      prompt: obj.usageMetadata.promptTokenCount ?? 0,
      completion: obj.usageMetadata.candidatesTokenCount ?? 0,
    };
  }

  const cand = obj.candidates?.[0];
  if (!cand) return { textDelta: "", done: false };

  let textDelta = "";
  for (const part of cand.content?.parts ?? []) {
    if (typeof part.text === "string" && part.text.length > 0) {
      accum.content += part.text;
      textDelta += part.text;
    }
    if (part.functionCall) {
      const name = part.functionCall.name ?? "";
      const argsObj = part.functionCall.args ?? {};
      const key = `${name}_${accum.toolOrder.length}`;
      accum.toolCalls.set(key, {
        id: key,
        name,
        arguments: JSON.stringify(argsObj),
        argFrags: [],
      });
      accum.toolOrder.push(key);
    }
  }

  const done = !!cand.finishReason;
  if (done) accum.finished = true;
  return { textDelta, done };
}
