/**
 * Per-provider tool-schema adapters (step-17).
 *
 * Input: `ProviderToolSpec[]` from the QueryEngine (the post-ATP described
 * tools). Output: provider-native tool descriptors ready to drop into
 * the request body.
 *
 *   - OpenAI / DeepSeek / GLM / Kimi / MiniMax-native:
 *       `{ type: "function", function: { name, description, parameters } }`
 *
 *   - Anthropic:
 *       `{ name, description, input_schema }`
 *
 *   - Gemini:
 *       `{ functionDeclarations: [{ name, description, parameters }] }`
 *       wrapped under `tools[]`. Gemini's parameter schema is a strict
 *       OpenAPI-3 subset; we sanitize incoming JSON Schema by stripping
 *       fields it doesn't accept (`$schema`, `additionalProperties`,
 *       `definitions` / `$defs`, format strings outside the allow-list).
 *
 *   - JSON-mode degradation (`supportsTools: 'json-mode'`):
 *       MiniMax-style providers don't ship native function calling. We
 *       inject a system-prompt addendum describing the available tools and
 *       ask the model to emit `<tool_use name="…">{json}</tool_use>` when
 *       it wants to call one. The QueryEngine recovers the call by parsing
 *       the assistant message after-the-fact (see `parseJsonModeToolCalls`
 *       below).
 *
 * Convention: every adapter is *pure* (no IO, no globals). The schema
 * passed in is a JSON-Schema-like object produced by zod's `.toJSON()`;
 * we deep-clone before mutating so the caller's object isn't aliased.
 */

import type { ToolCall } from "../types/messages.js";
import type { ProviderToolSpec } from "../types/provider.js";

// ---------------------------------------------------------------------------
// OpenAI-family (tools array)
// ---------------------------------------------------------------------------

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toOpenAITools(specs: ProviderToolSpec[]): OpenAITool[] {
  return specs.map((s) => ({
    type: "function" as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: normalizeJsonSchema(s.schemaJson),
    },
  }));
}

// ---------------------------------------------------------------------------
// Anthropic (tools array, but different field names)
// ---------------------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function toAnthropicTools(specs: ProviderToolSpec[]): AnthropicTool[] {
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: normalizeJsonSchema(s.schemaJson),
  }));
}

// ---------------------------------------------------------------------------
// Gemini (functionDeclarations[])
// ---------------------------------------------------------------------------

export interface GeminiFunctionDecl {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export function toGeminiTools(
  specs: ProviderToolSpec[],
): GeminiFunctionDecl[] {
  return specs.map((s) => {
    const params = sanitizeForGemini(normalizeJsonSchema(s.schemaJson));
    const decl: GeminiFunctionDecl = {
      name: s.name,
      description: s.description,
    };
    // Gemini rejects empty `parameters` — only attach when there are props.
    const hasProps =
      params &&
      typeof params === "object" &&
      params.properties &&
      Object.keys(params.properties as Record<string, unknown>).length > 0;
    if (hasProps) decl.parameters = params;
    return decl;
  });
}

// ---------------------------------------------------------------------------
// JSON-mode degradation
// ---------------------------------------------------------------------------

/**
 * Build a system-prompt addendum that teaches a tool-less provider how to
 * invoke a tool by emitting a `<tool_use>` envelope. Idempotent: callers
 * can append this once to their effective system prompt.
 */
export function toJsonModePromptInjection(
  specs: ProviderToolSpec[],
): string {
  if (specs.length === 0) return "";
  const lines: string[] = [
    "",
    "## Tool use (JSON-mode degradation)",
    "",
    "This provider does not support native function calling. To call a tool, " +
      "respond ONLY with a single line wrapped in <tool_use> ... </tool_use> tags. " +
      "Inside, emit a JSON object: " +
      `{"name":"<tool_name>","arguments":<json args>}.`,
    "",
    "After receiving the tool's output you may continue the conversation " +
      "normally. Do NOT mix prose and tool_use in the same response.",
    "",
    "Available tools:",
  ];
  for (const s of specs) {
    const schemaStr = safeJsonStringify(normalizeJsonSchema(s.schemaJson));
    lines.push(
      `- \`${s.name}\` — ${s.description.replace(/\s+/g, " ").trim()}`,
      `  schema: ${schemaStr}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

const TOOL_USE_RE = /<tool_use>\s*([\s\S]*?)\s*<\/tool_use>/gi;

/**
 * Parse `<tool_use>` envelopes out of a model response. Returns the
 * assistant text with envelopes stripped, plus the recovered tool calls
 * (if any). When the JSON inside an envelope fails to parse we silently
 * drop that one — callers should treat zero recovered calls as "the model
 * answered in prose".
 */
export function parseJsonModeToolCalls(content: string): {
  text: string;
  toolCalls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  let idx = 0;
  let match: RegExpExecArray | null;
  // Reset stateful regex per AGENTS.md §16 (don't share `g`-flag instances).
  TOOL_USE_RE.lastIndex = 0;
  while ((match = TOOL_USE_RE.exec(content)) !== null) {
    const inner = (match[1] ?? "").trim();
    try {
      const parsed = JSON.parse(inner) as { name?: unknown; arguments?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.name === "string") {
        calls.push({
          id: `jm_${idx++}`,
          name: parsed.name,
          arguments:
            typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
        });
      }
    } catch {
      /* malformed envelope — ignore */
    }
  }
  const text = content.replace(TOOL_USE_RE, "").trim();
  return { text, toolCalls: calls };
}

// ---------------------------------------------------------------------------
// JSON-Schema helpers
// ---------------------------------------------------------------------------

/**
 * Coerce zod's `toJSON()` output into a plain object schema accepted by
 * mainstream providers. The minimum shape every provider expects is:
 *
 *   { "type": "object", "properties": {…}, "required": [...] }
 *
 * We always provide that envelope, even when the upstream emits just
 * `{ type: "object" }` (no properties). Returns a deep clone.
 */
export function normalizeJsonSchema(input: unknown): Record<string, unknown> {
  const cloned = deepClone(input);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    return { type: "object", properties: {} };
  }
  const obj = cloned as Record<string, unknown>;
  if (obj.type === undefined) obj.type = "object";
  if (obj.type === "object" && obj.properties === undefined) {
    obj.properties = {};
  }
  return obj;
}

/** Gemini-specific schema sanitiser: drop fields the API rejects. */
function sanitizeForGemini(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const out = deepClone(schema) as Record<string, unknown>;
  walk(out);
  return out;

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    delete obj.$schema;
    delete obj.$id;
    delete obj.$ref;
    delete obj.$defs;
    delete obj.definitions;
    delete obj.additionalProperties;
    delete obj.exclusiveMaximum;
    delete obj.exclusiveMinimum;
    // Gemini accepts a small format allow-list; strip everything else.
    if (typeof obj.format === "string") {
      const allowed = new Set(["enum", "date-time"]);
      if (!allowed.has(obj.format)) delete obj.format;
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  }
}

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  // Bun + Node 20 ship structuredClone; it's the cheapest faithful clone.
  const sc = (globalThis as { structuredClone?: <U>(x: U) => U })
    .structuredClone;
  if (sc) return sc(v);
  return JSON.parse(JSON.stringify(v));
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "{}";
  }
}
