import type { z } from "zod";
import type { Tool, ToolDescriptor } from "../types/index.js";

/**
 * In-process tool registry (step-06).
 *
 * Step-06 extends the step-01 registry with two pieces of metadata stored
 * *next to* the tool object (not on it):
 *
 *   - `namespace` — coarse axis for filtering (`fs` / `exec` / `web` /
 *     `meta`). Matches the directory layout in `architecture.md §1`. The
 *     ATP allocator (step-07) and the permission engine (step-12) both
 *     consume it.
 *   - `enabledWhen` — a boolean predicate evaluated lazily on every call
 *     to `listTools` / `getTool`. This is the registry-level feature gate
 *     that pairs with `~/.chovy/features.json` (step-02).
 *
 * The metadata is intentionally external to `Tool` so plugins can register
 * the same tool object under different namespaces, and so we never freeze a
 * predicate onto the tool's prototype.
 */

interface RegistryEntry {
  tool: Tool;
  namespace?: string;
  /** Memoizes `enabledWhen()` per query? No — step-12 wants liveness. */
  enabledWhen?: () => boolean;
}

const entries = new Map<string, RegistryEntry>();

/** Optional metadata accepted by `registerTool`. */
export interface RegisterOptions {
  /** Logical bucket for filtering / permissions. */
  namespace?: string;
  /**
   * Evaluated lazily on every `listTools` / `getTool` call. Returning
   * `false` hides the tool from the registry view; the entry stays in
   * place so `registerTool` is not idempotent across toggles.
   */
  enabledWhen?: () => boolean;
}

/** Filter predicate for `listTools`. Both fields are optional. */
export interface ListFilter {
  namespace?: string;
  /**
   * When `true` (default `true`), tools whose `enabledWhen()` returns
   * `false` are dropped. Pass `false` to see *every* registered tool
   * regardless of its gate (admin / debug views).
   */
  enabled?: boolean;
}

export function registerTool<T extends z.ZodType>(
  tool: Tool<T>,
  opts: RegisterOptions = {},
): void {
  if (entries.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  entries.set(tool.name, {
    // Erase the narrow generic at storage time — entries are heterogeneous
    // and the registry only needs the common `Tool` surface.
    tool: tool as unknown as Tool,
    namespace: opts.namespace,
    enabledWhen: opts.enabledWhen,
  });
}

/** Look up a tool by name. Returns undefined if disabled by `enabledWhen`. */
export function getTool(name: string): Tool | undefined {
  const e = entries.get(name);
  if (!e) return undefined;
  if (e.enabledWhen && !e.enabledWhen()) return undefined;
  return e.tool;
}

/** List every registered tool, applying the optional filter. */
export function listTools(filter: ListFilter = {}): Tool[] {
  const checkEnabled = filter.enabled !== false; // default: only enabled
  const out: Tool[] = [];
  for (const e of entries.values()) {
    if (filter.namespace && e.namespace !== filter.namespace) continue;
    if (checkEnabled && e.enabledWhen && !e.enabledWhen()) continue;
    out.push(e.tool);
  }
  return out;
}

/** Drop everything from the registry — primarily for tests. */
export function resetToolRegistry(): void {
  entries.clear();
}

/**
 * Inspect a tool's namespace without exposing the entry shape.
 * Returns `undefined` if the tool is unknown.
 */
export function namespaceOf(name: string): string | undefined {
  return entries.get(name)?.namespace;
}

// ---------------------------------------------------------------------------
// Legacy descriptor view (kept for callers that import it directly)
// ---------------------------------------------------------------------------

/**
 * Legacy provider-facing descriptor view. The ATP-aware variant lives in
 * `src/tools/describe.ts` (`describeTools(opts)`); this helper is kept as
 * a thin name-or-all dump that doesn't make budgeting decisions.
 *
 * @deprecated Prefer `describeTools` from `./describe.js` once step-07
 * lands. This export is kept so nothing in the codebase silently breaks.
 */
export function describeToolsLegacy(names?: string[]): ToolDescriptor[] {
  const all = listTools();
  const selected = names ? all.filter((t) => names.includes(t.name)) : all;
  return selected.map((t) => ({
    name: t.name,
    description: t.desc?.lean ?? t.description ?? "",
    schema:
      (t.schema as unknown as { toJSON?: () => Record<string, unknown> })
        .toJSON?.() ?? { type: "object" },
  }));
}
