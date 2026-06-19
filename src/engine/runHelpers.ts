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
  AgentRole,
  ChatMessage,
  ParentRuntimeCtx,
  PermissionPreflight,
  ProviderId,
  SpawnFn,
  Tool,
  ToolContext,
} from "../types/index.js";
import type { BuildOptions } from "../prompts/index.js";
import type {
  ContextBudgetSnippet,
  PressureSnippet,
  SkillFragmentsSnippet,
} from "../prompts/index.js";
import type { QueryRunOptions } from "./queryEngine.js";
import {
  getSpawnFnBuilder,
  getDispatchFnBuilder,
} from "./runtimeRegistry.js";

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
 * context (cwd / model / planMode / SCW pressure + budget) the engine knows.
 *
 * step-27 added two optional fields:
 *   - `runCtx.pressure`  — SCW `<context-pressure>` block; injected by the
 *                          monitor on level transitions, applied to the
 *                          NEXT round's build.
 *   - `runCtx.contextBudget` — live ctx-budget line; reflects the
 *                          previous round's measured token usage so the
 *                          model sees real numbers, not a placeholder.
 *
 * step-29 added two more (CSG):
 *   - `runCtx.loadedSkills` — names list for the `## Loaded skills` ToC.
 *   - `runCtx.skillFragments` — body blocks for `## Active skills`.
 *   Both come from `runSkillRound` (`engine/skillHook.ts`), which reads
 *   `ToolSession.activeSkillFragments`.
 *
 * step-30 wires `runCtx.memoryText` from `engine/memoryHook.ts` into the
 * existing `SystemContext.memoryText` slot frozen at step-15.
 */
export function fillBuildOptions(
  opts: QueryRunOptions,
  runCtx: {
    provider: ProviderId;
    model: string;
    cwd: string;
    planMode: boolean;
    pressure?: PressureSnippet;
    contextBudget?: ContextBudgetSnippet;
    memoryText?: string;
    loadedSkills?: string[];
    skillFragments?: SkillFragmentsSnippet;
  },
): BuildOptions {
  const base: BuildOptions = {
    context: {
      cwd: { cwd: runCtx.cwd },
      model: { provider: runCtx.provider, model: runCtx.model },
      planMode: runCtx.planMode,
      ...(runCtx.memoryText ? { memoryText: runCtx.memoryText } : {}),
      ...(runCtx.pressure ? { pressure: runCtx.pressure } : {}),
      ...(runCtx.contextBudget ? { contextBudget: runCtx.contextBudget } : {}),
      ...(runCtx.loadedSkills && runCtx.loadedSkills.length > 0
        ? { loadedSkills: runCtx.loadedSkills }
        : {}),
      ...(runCtx.skillFragments && runCtx.skillFragments.fragments.length > 0
        ? { skillFragments: runCtx.skillFragments }
        : {}),
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

// ── spawn / dispatch handle construction ───────────────────────────────────

export interface SpawnHandlesInput {
  role: AgentRole;
  agentId: string;
  provider: ProviderId;
  model: string;
  mode: PermissionEngineState["mode"];
  messages: ChatMessage[];
  signal: AbortSignal;
}

export interface SpawnHandles {
  spawn?: SpawnFn;
  dispatch?: ToolContext["dispatchSwarm"];
}

/**
 * Build the spawn / dispatch handles for a run. Only the top-level `main`
 * role gets handles — sub-agents recursing through dispatch is opt-in
 * (step-20 left for a future step). Builders are registered indirectly
 * via `runtimeRegistry` (avoids the `engine → swarm → agent → engine`
 * cycle), and the closures hold the engine's *live* `messages` array so
 * the snapshot the child receives reflects what the parent has seen up
 * to the call moment.
 */
export function buildSpawnHandles(input: SpawnHandlesInput): SpawnHandles {
  if (input.role !== "main") return {};
  const spawnBuilder = getSpawnFnBuilder();
  if (!spawnBuilder) return {};
  const parentCtx: ParentRuntimeCtx = {
    parentId: input.agentId,
    parentRole: input.role,
    parentProvider: input.provider,
    parentModel: input.model,
    parentMode: input.mode,
    parentMessages: input.messages,
    parentSignal: input.signal,
  };
  const spawn = spawnBuilder(parentCtx);
  const dispatchBuilder = getDispatchFnBuilder();
  const dispatch = dispatchBuilder ? dispatchBuilder(parentCtx) : undefined;
  return { spawn, dispatch };
}
