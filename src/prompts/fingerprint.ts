/**
 * PSF — Prompt Shape Fingerprint (step-15).
 *
 * A generalization of cc-haha's Anthropic-specific
 * `promptCacheBreakDetection`. Instead of being tied to a single
 * provider's cache pricing, PSF emits a per-request "shape" record:
 *   - `staticHash` over the system-prompt prefix (above the boundary),
 *   - `dynamicHash` over the prefix below the boundary,
 *   - `toolsHash` over the ordered tool name list,
 *   - `perToolHash` over each tool's lean/full text + schema.
 *
 * Two shapes can be `diffShape`-d to explain why a cache (Anthropic) or
 * stable-prefix bonus (every other provider) was lost. The cost: O(n)
 * 32-bit FNV hashes — cheap enough to run every request.
 *
 * Hashes are 32-bit unsigned ints (fits in JSON number losslessly,
 * stringifies short, deterministic across platforms). Telemetry consumers
 * shouldn't compare these across binaries — different builds may change
 * `JSON.stringify` ordering for nested schemas; we sort keys to mitigate.
 */

import type { DescribedTool } from "../tools/describe.js";
import type { EffectivePrompt } from "./builders.js";

export interface PromptShape {
  /** Provider model id, e.g. `gpt-4o-mini`. */
  modelId: string;
  staticHash: number;
  dynamicHash: number;
  toolsHash: number;
  toolNames: string[];
  perToolHash: Record<string, number>;
  systemBytes: number;
  injectedSegments: string[];
  ts: number;
}

export interface ShapeDiff {
  /** True iff every hash matches. */
  identical: boolean;
  changedFields: Array<
    | "static"
    | "dynamic"
    | "toolsList"
    | "perTool"
    | "model"
  >;
  toolsAdded: string[];
  toolsRemoved: string[];
  /** Names whose perTool hash changed despite the tools list being equal. */
  toolsMutated: string[];
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit (small, deterministic, no deps).
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(input: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Math.imul keeps the multiply 32-bit; >>> 0 turns the result unsigned.
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable JSON for hashing — keys sorted recursively so two equal objects
 * with different key insertion order hash the same.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableJson(obj[k])).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeShape(
  prompt: EffectivePrompt,
  tools: DescribedTool[],
  modelId: string,
): PromptShape {
  const toolNames = tools.map((t) => t.name);
  const perToolHash: Record<string, number> = {};
  for (const t of tools) {
    perToolHash[t.name] = fnv1a(
      `${t.level}|${t.description}|${stableJson(t.schemaJson)}`,
    );
  }
  return {
    modelId,
    staticHash: prompt.staticHash,
    dynamicHash: prompt.dynamicHash,
    toolsHash: fnv1a(toolNames.join("|")),
    toolNames,
    perToolHash,
    systemBytes: prompt.text.length,
    injectedSegments: prompt.segments.map((s) => s.name),
    ts: Date.now(),
  };
}

export function diffShape(a: PromptShape, b: PromptShape): ShapeDiff {
  const changed: ShapeDiff["changedFields"] = [];
  if (a.modelId !== b.modelId) changed.push("model");
  if (a.staticHash !== b.staticHash) changed.push("static");
  if (a.dynamicHash !== b.dynamicHash) changed.push("dynamic");
  if (a.toolsHash !== b.toolsHash) changed.push("toolsList");

  const aSet = new Set(a.toolNames);
  const bSet = new Set(b.toolNames);
  const toolsAdded = b.toolNames.filter((n) => !aSet.has(n));
  const toolsRemoved = a.toolNames.filter((n) => !bSet.has(n));

  const toolsMutated: string[] = [];
  for (const name of b.toolNames) {
    if (!aSet.has(name)) continue; // already covered by toolsAdded
    if (a.perToolHash[name] !== b.perToolHash[name]) toolsMutated.push(name);
  }
  if (toolsMutated.length > 0) changed.push("perTool");

  return {
    identical: changed.length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0,
    changedFields: changed,
    toolsAdded,
    toolsRemoved,
    toolsMutated,
  };
}

/** Expose the FNV helper for unit tests / advanced consumers. */
export { fnv1a as _fnv1aForTesting };
