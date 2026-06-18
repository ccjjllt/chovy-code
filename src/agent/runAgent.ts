/**
 * Generic agent runner — thin lifecycle wrapper over `QueryEngine` (step-16).
 *
 * The engine is the dumb worker; `runAgent` adds the *agent* shape:
 *   - one prompt → one final answer (back-compat with the legacy
 *     `runAgent(prompt, opts)` signature in `agent.ts`),
 *   - friendly callbacks (`onToken` / `onToolCall`) that map onto the
 *     engine's richer `onToken` / `onToolStart` / `onToolEnd`,
 *   - per-run AbortController (sub-agents will wrap this with their own),
 *   - default model resolution via the provider registry.
 *
 * Sub-agents (step-18 / step-19) layer on top of this by injecting
 * `agentRole`, `parentId`, `tools[Allowlist|Denylist]`, and an isolated
 * AbortController.
 *
 * The legacy `agent.ts` re-exports this entry point so existing CLI /
 * REPL imports keep working unchanged.
 */

import { QueryEngine, setSpawnFnBuilder, setDispatchFnBuilder, type QueryEngineDeps, type QueryRunOptions, type QueryRunResult } from "../engine/index.js";
import { getProvider } from "../providers/index.js";
import { logger } from "../logger/index.js";
import { getSubAgentPool } from "./pool.js";
import { dispatch as swarmDispatch } from "../swarm/router.js";
import type {
  AgentRole,
  ChatMessage,
  ParentRuntimeCtx,
  ProviderId,
  SpawnFn,
  SpawnInput,
  ToolContext,
  ToolResult,
} from "../types/index.js";

// ── step-18: register the sub-agent spawn factory ─────────────────────────
//
// Wired here (rather than in the barrel) so every entry point — REPL,
// `chovy chat`, the legacy `agent/agent.ts` shim, and any direct
// `runQuery(...)` consumer — picks up the registration without an extra
// import. The registration is idempotent: re-importing the module
// re-installs the same builder.
//
// The builder closes over the engine's *live* parent message array
// (supplied via `parentCtx.parentMessages`) so the snapshot the child
// receives reflects the parent's transcript at spawn time.
setSpawnFnBuilder((parentCtx: ParentRuntimeCtx): SpawnFn => {
  const pool = getSubAgentPool();
  return (input: SpawnInput) => pool.spawn(input, { parentCtx });
});

// ── step-20: register the SwarmR dispatch factory ──────────────────────────
//
// Same indirection pattern as `setSpawnFnBuilder`: the engine never imports
// `swarm/router` directly (that would cycle engine → swarm → agent → engine).
// We register a builder here — imported from `swarm/router.js`, which only
// reaches the leaf `agent/pool.js` (not the `agent/index` barrel that
// re-exports `runAgent`), so the graph stays acyclic.
//
// The handle closes over the live parentCtx so a dispatch inherits the
// parent snapshot + abort cascade exactly like a single spawn. The engine's
// local AbortController (wrapping the parent's signal) is forwarded as the
// dispatch `abortSignal` so cancelling the parent run cancels any in-flight
// dispatch as well — without sharing the parent's signal object across the
// dispatch's own spawns (each child still gets its own AC inside the pool).
setDispatchFnBuilder((parentCtx: ParentRuntimeCtx): ToolContext["dispatchSwarm"] => {
  return (input) =>
    swarmDispatch(
      // Forward the parent's abort signal as the dispatch abort signal so
      // cancelling the parent run cancels any in-flight dispatch. Each
      // child still gets its OWN AbortController inside the pool (the
      // router wraps this signal in a local AC per AGENTS.md §9); the
      // parent signal is only observed, never shared across spawns.
      { ...input, abortSignal: input.abortSignal ?? parentCtx.parentSignal },
      parentCtx,
    );
});

export interface AgentOptions {
  provider: ProviderId;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Cap on tool-call rounds per `run()` to avoid runaway loops. */
  maxRounds?: number;
  /** Hard cap on USD spend; default Infinity. */
  budgetUSD?: number;
  /** Called for every assistant token (streaming UI). */
  onToken?: (delta: string) => void;
  /** Called whenever the agent executes a tool. */
  onToolCall?: (name: string, args: unknown) => void;
  /**
   * External abort signal. Sub-agents MUST construct their own (AGENTS.md §9);
   * the engine internally wraps whatever we pass in a fresh AbortController.
   */
  abortSignal?: AbortSignal;
  /** Optional `ask_user_question` callback supplied by the UI (step-22). */
  askUser?: ToolContext["askUser"];
  /** Honors `process.stdin.isTTY` by default; UI may override. */
  isInteractive?: ToolContext["isInteractive"];
  /** Permission mode for this run (step-12). Defaults to `config.permissionMode`. */
  permissionMode?: string;
  /** Settings paths for the hook engine (step-13). */
  hooksSettingsPaths?: string[];
  /** Surface hook stderr / block reasons in the UI. */
  onHookMessage?: (message: string) => void;
  /** Sub-agent / swarm bookkeeping. */
  agentRole?: AgentRole;
  agentId?: string;
  parentId?: string;
  /** Override the default tool pool (sub-agents pass their whitelist here). */
  toolAllowlist?: string[];
  toolDenylist?: string[];
  /** Token budget for ATP allocator. */
  toolBudgetTokens?: number;
}

/**
 * One-shot entry: feeds `prompt` as the first user message, runs the
 * engine until either a final answer or `maxRounds` lands, and returns
 * the assistant text. Matches the legacy `runAgent` signature so existing
 * CLI / REPL code continues to work without changes.
 *
 * For multi-turn / advanced uses (sub-agents, goal loop), construct a
 * `QueryEngine` directly and call `engine.run(opts)`.
 */
export async function runAgent(
  prompt: string,
  opts: AgentOptions,
): Promise<string> {
  const provider = getProvider(opts.provider);
  provider.assertReady();

  const messages: ChatMessage[] = [
    { role: "user", content: prompt, ts: Date.now() },
  ];

  const engine = new QueryEngine();
  const result = await engine.run(buildRunOptions(messages, opts));

  if (result.stopReason === "cancelled") {
    logger.debug("runAgent: cancelled", { rounds: result.rounds });
    return result.finalContent || "(cancelled)";
  }
  if (result.stopReason === "budgetExceeded") {
    logger.warn("runAgent: budget exceeded", {
      usd: result.costUSD,
    });
  }
  return result.finalContent;
}

/**
 * Multi-turn entry: lets callers seed an existing message list and
 * receive the full result (rounds / cost / messages / shapes) instead of
 * just the final content. Used by sub-agents / swarm / goal.
 */
export async function runQuery(
  messages: ChatMessage[],
  opts: AgentOptions,
  deps?: QueryEngineDeps,
): Promise<QueryRunResult> {
  const provider = getProvider(opts.provider);
  provider.assertReady();
  const engine = new QueryEngine(deps);
  return engine.run(buildRunOptions(messages, opts));
}

function buildRunOptions(
  messages: ChatMessage[],
  opts: AgentOptions,
): QueryRunOptions {
  const out: QueryRunOptions = {
    messages,
    provider: opts.provider,
    model: opts.model,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    permissionMode: opts.permissionMode,
    hooksSettingsPaths: opts.hooksSettingsPaths,
    abortSignal: opts.abortSignal,
    agentRole: opts.agentRole,
    agentId: opts.agentId,
    parentId: opts.parentId,
    askUser: opts.askUser,
    isInteractive: opts.isInteractive,
    toolAllowlist: opts.toolAllowlist,
    toolDenylist: opts.toolDenylist,
    toolBudgetTokens: opts.toolBudgetTokens,
    maxRounds: opts.maxRounds,
    budgetUSD: opts.budgetUSD,
    onHookMessage: opts.onHookMessage,
    onToken: opts.onToken,
    onToolStart: opts.onToolCall
      ? (name: string, args: unknown) => opts.onToolCall!(name, args)
      : undefined,
    onToolEnd: opts.onToolCall
      ? (_name: string, _result: ToolResult) => {
          /* legacy callback only fires on start; end is observed via final result */
        }
      : undefined,
  };

  // Layer 3 of the system prompt: user-supplied custom prompt (the legacy
  // `systemPrompt` option). Kept additive — it stacks above the chovy
  // default per `docs/step-15-system-prompt.md §5 层优先级`.
  if (opts.systemPrompt) {
    out.systemPromptOpts = { custom: opts.systemPrompt };
  }
  return out;
}
