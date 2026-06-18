/**
 * QueryEngine helpers — pure, stateless functions extracted to keep
 * `queryEngine.ts` under the AGENTS.md §17 600-line cap.
 *
 * Each helper reads only its arguments and never touches engine state. They
 * live here (not on the class) so future SCW / Goal Loop additions can grow
 * the main loop without bumping the cap.
 */
import { getTool, listTools } from "../tools/index.js";
import {
  hasPermission,
  type PermissionEngineState,
} from "../harness/permissions/index.js";
import type {
  PermissionPreflight,
  ProviderId,
  Tool,
  ToolContext,
} from "../types/index.js";
import type { BuildOptions } from "../prompts/index.js";
import type { QueryRunOptions } from "./queryEngine.js";

// ── tool pool resolution ──────────────────────────────────────────────────

/**
 * Pick the engine's tool pool for this run: caller-injected list (sub-agents)
 * else every enabled tool, then apply allow/deny lists from `opts`.
 */
export function resolveToolPool(opts: QueryRunOptions): Tool[] {
  const all = opts.tools ?? listTools({ enabled: true });
  let pool = all;
  if (opts.toolAllowlist && opts.toolAllowlist.length > 0) {
    const allow = new Set(opts.toolAllowlist);
    pool = pool.filter((t) => allow.has(t.name));
  }
  if (opts.toolDenylist && opts.toolDenylist.length > 0) {
    const deny = new Set(opts.toolDenylist);
    pool = pool.filter((t) => !deny.has(t.name));
  }
  return pool;
}

// ── permission preflight adapter ──────────────────────────────────────────

/**
 * Adapter satisfying the frozen `PermissionEngine.preflight?` hook signature.
 * The engine wraps this into `ToolContext.permissions.preflight` so the
 * permission engine binds to *live* engine state on every call.
 */
export async function runPreflight(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
  permState: PermissionEngineState,
): Promise<PermissionPreflight> {
  const tool = getTool(toolName);
  if (!tool) {
    return { outcome: "deny", reason: `unknown tool "${toolName}"` };
  }
  const decision = await hasPermission(tool, args, ctx, permState);
  return {
    outcome: decision.outcome,
    reason: decision.reason,
    matchedRule: decision.matchedRule,
  };
}

// ── BuildOptions helper ───────────────────────────────────────────────────

/**
 * Compose the effective `BuildOptions` for `buildEffectiveSystemPrompt`,
 * merging `opts.systemPromptOpts` (caller layer-overrides) with the runtime
 * context (cwd / model / planMode) the engine knows.
 */
export function fillBuildOptions(
  opts: QueryRunOptions,
  runCtx: { provider: ProviderId; model: string; cwd: string; planMode: boolean },
): BuildOptions {
  const base: BuildOptions = {
    context: {
      cwd: { cwd: runCtx.cwd },
      model: { provider: runCtx.provider, model: runCtx.model },
      planMode: runCtx.planMode,
    },
  };
  if (!opts.systemPromptOpts) return base;
  return {
    ...base,
    ...opts.systemPromptOpts,
    context: {
      ...base.context,
      ...(opts.systemPromptOpts.context ?? {}),
    },
  };
}

// ── id minting ─────────────────────────────────────────────────────────────

/**
 * Mint an opaque agent id (`agt_<rand>`). Uses `crypto.randomUUID` when
 * available (Bun, Node ≥ 19, modern browsers); falls back to a timestamp +
 * random suffix.
 */
export function makeAgentId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `agt_${g.crypto.randomUUID()}`;
  return `agt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
