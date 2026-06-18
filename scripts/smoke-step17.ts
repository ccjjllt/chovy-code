/**
 * step-17 providers smoke test.
 *
 * Validates the new pieces from `docs/step-17-providers-real.md` *without*
 * touching the network — every fetch is mocked. The acceptance items from
 * the doc are:
 *
 *   1. PCM (`getCapability`) returns a coherent entry for every provider
 *      and the table lines up with `ProviderId`.
 *   2. SSE parser (`parseSSE`) handles split chunks, [DONE], and CRLF.
 *   3. Per-family delta merger assembles tool calls + text correctly for
 *      gpt / claude / gemini.
 *   4. Tool format adapters produce shapes a hand-rolled assertion
 *      recognizes (OpenAI / Anthropic / Gemini / json-mode).
 *   5. Each of the 7 providers can be invoked end-to-end via mocked fetch
 *      and yields an "echo via tool" tool call (matches step-17 §验收 4).
 *
 * Run:  bun run scripts/smoke-step17.ts
 */

import {
  CAPS,
  finalizeCompletion,
  getCapability,
  mergeDelta,
  newAccumulator,
  parseJsonModeToolCalls,
  parseSSE,
  toAnthropicTools,
  toGeminiTools,
  toJsonModePromptInjection,
  toOpenAITools,
  getProvider,
} from "../src/providers/index.js";
import type {
  ProviderId,
  ProviderRequestOptions,
  ProviderToolSpec,
} from "../src/types/index.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ✔ ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✘ ${label}\n`);
    if (detail) process.stdout.write(`      ${detail}\n`);
  }
}
function header(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// ---------------------------------------------------------------------------
// 1. Capability matrix
// ---------------------------------------------------------------------------

header("1. Provider Capability Matrix (PCM)");
const allIds: ProviderId[] = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "minimax",
  "glm",
  "kimi",
];
for (const id of allIds) {
  const cap = getCapability(id);
  check(
    `getCapability(${id})`,
    cap.contextWindow > 0 &&
      typeof cap.supportsTools === "string" &&
      typeof cap.pricing.in === "number" &&
      typeof cap.pricing.out === "number",
    JSON.stringify(cap),
  );
}
check(
  "minimax tools are flagged json-mode",
  CAPS.minimax.supportsTools === "json-mode",
);

// ---------------------------------------------------------------------------
// 2. SSE parser
// ---------------------------------------------------------------------------

header("2. SSE parser");
async function collectSSE(chunks: string[]): Promise<{ event?: string; data: string }[]> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  const out: { event?: string; data: string }[] = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  return out;
}

const events1 = await collectSSE([
  "data: {\"a\":1}\n\n",
  "data: {\"b\":2}\n\n",
  "data: [DONE]\n\n",
  "data: {\"never\":1}\n\n",
]);
check("parses two events and stops at [DONE]", events1.length === 2 && events1[0]!.data === '{"a":1}');

const events2 = await collectSSE([
  "event: message_start\r\ndata: {\"type\":\"message_start\"}\r\n\r\n",
  "event: content_block_delta\r\ndata: {\"delta\":",
  "{\"type\":\"text_delta\",\"text\":\"hi\"}}\r\n\r\n",
]);
check(
  "handles event names + chunk-split data + CRLF",
  events2.length === 2 && events2[1]!.event === "content_block_delta",
);

// Split mid-line: a chunk ends mid-payload, the next chunk completes it.
const events3 = await collectSSE([
  "data: {\"chunk\":",
  "\"split\"}\n\n",
]);
check("recovers split-mid-payload events", events3.length === 1 && events3[0]!.data === '{"chunk":"split"}');

// ---------------------------------------------------------------------------
// 3. Per-family delta merger
// ---------------------------------------------------------------------------

header("3. Per-family delta merger");

// 3a. gpt — text + tool call assembly
{
  const accum = newAccumulator();
  const evs = [
    { data: '{"choices":[{"delta":{"content":"He"}}]}' },
    { data: '{"choices":[{"delta":{"content":"llo"}}]}' },
    {
      data:
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo"}}]}}]}',
    },
    {
      data:
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"message\\":"}}]}}]}',
    },
    {
      data:
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}',
    },
    { data: '{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}' },
  ];
  let saw = false;
  for (const ev of evs) {
    const r = mergeDelta("gpt", accum, ev);
    if (r.done) saw = true;
  }
  const final = finalizeCompletion(accum);
  check(
    "gpt: text accumulated",
    final.content === "Hello",
    `got ${JSON.stringify(final.content)}`,
  );
  check(
    "gpt: tool call coalesced",
    final.toolCalls.length === 1 &&
      final.toolCalls[0]!.name === "echo" &&
      final.toolCalls[0]!.arguments === '{"message":"hi"}',
    JSON.stringify(final.toolCalls),
  );
  check("gpt: usage parsed", final.usage?.prompt === 7 && final.usage?.completion === 3);
  check("gpt: stop seen", saw);
}

// 3b. claude — text + tool_use block + input_json_delta
{
  const accum = newAccumulator();
  const evs = [
    { event: "message_start", data: '{"message":{"usage":{"input_tokens":10,"output_tokens":0}}}' },
    {
      event: "content_block_start",
      data: '{"index":0,"content_block":{"type":"text","text":""}}',
    },
    {
      event: "content_block_delta",
      data: '{"index":0,"delta":{"type":"text_delta","text":"hi"}}',
    },
    {
      event: "content_block_start",
      data:
        '{"index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"echo","input":{}}}',
    },
    {
      event: "content_block_delta",
      data: '{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"message\\":\\"hi\\"}"}}',
    },
    {
      event: "message_delta",
      data: '{"usage":{"input_tokens":10,"output_tokens":4}}',
    },
    { event: "message_stop", data: '{}' },
  ];
  let textDelta = "";
  for (const ev of evs) {
    const r = mergeDelta("claude", accum, ev);
    textDelta += r.textDelta;
  }
  const final = finalizeCompletion(accum);
  check("claude: text accumulated", textDelta === "hi" && final.content === "hi");
  check(
    "claude: tool_use captured",
    final.toolCalls.length === 1 &&
      final.toolCalls[0]!.name === "echo" &&
      final.toolCalls[0]!.id === "toolu_1" &&
      final.toolCalls[0]!.arguments === '{"message":"hi"}',
    JSON.stringify(final.toolCalls),
  );
  check("claude: usage parsed", final.usage?.completion === 4);
}

// 3c. gemini — text + functionCall
{
  const accum = newAccumulator();
  const evs = [
    {
      data: '{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',
    },
    {
      data:
        '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"echo","args":{"message":"hi"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}',
    },
  ];
  for (const ev of evs) mergeDelta("gemini", accum, ev);
  const final = finalizeCompletion(accum);
  check("gemini: text accumulated", final.content === "hi");
  check(
    "gemini: function call captured",
    final.toolCalls.length === 1 &&
      final.toolCalls[0]!.name === "echo" &&
      final.toolCalls[0]!.arguments === '{"message":"hi"}',
    JSON.stringify(final.toolCalls),
  );
}

// ---------------------------------------------------------------------------
// 4. Tool format adapters
// ---------------------------------------------------------------------------

header("4. Tool format adapters");

const echoSpec: ProviderToolSpec = {
  name: "echo",
  description: "Echo back the provided message.",
  schemaJson: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

const oa = toOpenAITools([echoSpec]);
check(
  "toOpenAITools shape",
  oa[0]!.type === "function" && oa[0]!.function.name === "echo" &&
    (oa[0]!.function.parameters as { type?: string }).type === "object",
);
const an = toAnthropicTools([echoSpec]);
check(
  "toAnthropicTools shape",
  an[0]!.name === "echo" && (an[0]!.input_schema as { type?: string }).type === "object",
);
const ge = toGeminiTools([echoSpec]);
check("toGeminiTools shape", ge[0]!.name === "echo" && !!ge[0]!.parameters);

const inj = toJsonModePromptInjection([echoSpec]);
check(
  "toJsonModePromptInjection mentions tool name + envelope",
  inj.includes("echo") && inj.includes("<tool_use>"),
);

const recovered = parseJsonModeToolCalls(
  'I will call <tool_use>{"name":"echo","arguments":{"message":"hi"}}</tool_use> now.',
);
check(
  "parseJsonModeToolCalls extracts call",
  recovered.toolCalls.length === 1 &&
    recovered.toolCalls[0]!.name === "echo" &&
    recovered.toolCalls[0]!.arguments === '{"message":"hi"}',
);
check(
  "parseJsonModeToolCalls strips envelope from text",
  !recovered.text.includes("<tool_use>"),
);

// ---------------------------------------------------------------------------
// 5. Provider end-to-end via mocked fetch ("echo via tool" smoke)
// ---------------------------------------------------------------------------

header("5. Provider mock-fetch smoke (echo via tool)");

const ECHO_TOOLS: ProviderToolSpec[] = [echoSpec];

interface MockCase {
  id: ProviderId;
  envKey: string;
  json: unknown;
  /** Whether the response should be parsed as tool-call producing. */
  expectToolCall: boolean;
}

const cases: MockCase[] = [
  {
    id: "openai",
    envKey: "OPENAI_API_KEY",
    expectToolCall: true,
    json: {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: '{"message":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    },
  },
  {
    id: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    expectToolCall: true,
    json: {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: '{"message":"hi"}' },
              },
            ],
          },
        },
      ],
    },
  },
  {
    id: "kimi",
    envKey: "KIMI_API_KEY",
    expectToolCall: true,
    json: {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: '{"message":"hi"}' },
              },
            ],
          },
        },
      ],
    },
  },
  {
    id: "glm",
    envKey: "GLM_API_KEY",
    expectToolCall: true,
    json: {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: '{"message":"hi"}' },
              },
            ],
          },
        },
      ],
    },
  },
  {
    id: "minimax",
    envKey: "MINIMAX_API_KEY",
    expectToolCall: true,
    // MiniMax json-mode degradation: echo back a `<tool_use>` envelope
    // and let `parseJsonModeToolCalls` recover it.
    json: {
      choices: [
        {
          message: {
            content:
              'Sure: <tool_use>{"name":"echo","arguments":{"message":"hi"}}</tool_use>',
          },
        },
      ],
    },
  },
  {
    id: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    expectToolCall: true,
    json: {
      content: [
        { type: "text", text: "" },
        { type: "tool_use", id: "toolu_1", name: "echo", input: { message: "hi" } },
      ],
      usage: { input_tokens: 12, output_tokens: 5 },
    },
  },
  {
    id: "gemini",
    envKey: "GEMINI_API_KEY",
    expectToolCall: true,
    json: {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "echo", args: { message: "hi" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    },
  },
];

const realFetch = globalThis.fetch;
let fetchCalls = 0;

for (const c of cases) {
  process.env[c.envKey] = process.env[c.envKey] ?? "test-key";

  // Mock fetch for this provider.
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    fetchCalls++;
    return new Response(JSON.stringify(c.json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    const provider = getProvider(c.id);
    const opts: ProviderRequestOptions = {
      model: provider.info.defaultModel,
      messages: [{ role: "user", content: "echo hi" }],
      systemPrompt: "be brief",
      toolSpecs: ECHO_TOOLS,
      maxTokens: 200,
    };
    const completion = await provider.complete(opts);
    const ok =
      completion.toolCalls.length >= 1 &&
      completion.toolCalls[0]!.name === "echo" &&
      completion.toolCalls[0]!.arguments.includes("hi");
    check(
      `${c.id}.complete() → tool call echo("hi")`,
      ok,
      JSON.stringify(completion),
    );
  } catch (err) {
    check(
      `${c.id}.complete() → tool call echo("hi")`,
      false,
      (err as Error).message,
    );
  }
}

globalThis.fetch = realFetch;
check("mock fetch was invoked once per provider", fetchCalls === cases.length);

// ---------------------------------------------------------------------------
// 6. Streaming end-to-end (mock SSE per family)
// ---------------------------------------------------------------------------

header("6. Streaming end-to-end (mock SSE)");

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

interface StreamCase {
  id: ProviderId;
  envKey: string;
  chunks: string[];
}

const streamCases: StreamCase[] = [
  {
    id: "openai",
    envKey: "OPENAI_API_KEY",
    chunks: [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ],
  },
  {
    id: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    chunks: [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
  },
  {
    id: "gemini",
    envKey: "GEMINI_API_KEY",
    chunks: [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}]}\n\n',
    ],
  },
];

for (const sc of streamCases) {
  process.env[sc.envKey] = process.env[sc.envKey] ?? "test-key";
  globalThis.fetch = (async () =>
    new Response(sseStream(sc.chunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof fetch;
  const provider = getProvider(sc.id);
  if (!provider.stream) {
    check(`${sc.id} exposes stream()`, false);
    continue;
  }
  let text = "";
  let final: { content?: string } | undefined;
  try {
    for await (const chunk of provider.stream({
      model: provider.info.defaultModel,
      messages: [{ role: "user", content: "say hi" }],
      maxTokens: 50,
    })) {
      if (typeof chunk === "string") text += chunk;
      else final = chunk;
    }
    check(
      `${sc.id} stream() → "Hello world"`,
      text === "Hello world" && final?.content === "Hello world",
      `text=${JSON.stringify(text)} final=${JSON.stringify(final?.content)}`,
    );
  } catch (err) {
    check(`${sc.id} stream() → "Hello world"`, false, (err as Error).message);
  }
}
globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

header("Summary");
if (failures === 0) {
  process.stdout.write(`All step-17 smoke checks passed.\n`);
  process.exit(0);
} else {
  process.stdout.write(`${failures} step-17 smoke check(s) FAILED.\n`);
  process.exit(1);
}
