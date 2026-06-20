/**
 * QueryEngine — the chovy-code core loop (step-16).
 *
 * Replaces the simple `runAgent` from `src/agent/agent.ts`. The legacy
 * function survives as a back-compat shim that constructs an engine and
 * forwards a single user prompt; everything new (sub-agents, swarm, goal
 * loop) calls `engine.run(opts)` directly.
 *
 * Per round: CSG → TMT memory → system prompt → ATP → SCW → provider →
 * cost → assistant/tool turns. Helper modules own the bulky subflows so this
 * file stays within the 600-line cap.
 */

import { logger } from "../logger/index.js";
import { emitTelemetry, getTelemetrySink } from "../telemetry/index.js";
import { loadConfig, type ChovyConfig, type PermissionMode } from "../config/index.js";
import { projectId as deriveProjectId } from "../fs/paths.js";
import { describeTools } from "../tools/index.js";
import type { DescribedTool } from "../tools/index.js";
import { getProvider } from "../providers/index.js";
import {
  buildEffectiveSystemPrompt,
  computeShape,
  type BuildOptions,
  type EffectivePrompt,
  type PressureSnippet,
} from "../prompts/index.js";
import {
  createPermissionEngineState,
  permissionModeFromString,
  type PermissionEngineState,
} from "../harness/permissions/index.js";
import { createHookEngine } from "../harness/hooks/index.js";
import type { HookContext } from "../harness/hooks/index.js";
import type {
  AgentRole,
  ChatMessage,
  ContextBudget,
  ProviderId,
  SpawnFn,
  Tool,
  ToolContext,
  ToolResult,
  ToolSession,
} from "../types/index.js";
import type { ContextMonitor, MonitorState } from "../context/index.js";
import { getCheckpointCoordinator } from "../memory/checkpointWriter.js";
import { CostTracker, type TokenUsage } from "./costTracker.js";
import { normalizeForProvider, pruneOrphanToolMessages } from "./messageNormalize.js";
import { runStream } from "./streamHandler.js";
import { executeToolCall } from "./toolExecutor.js";
import { createContextMonitorIfEnabled } from "./contextHook.js";
import { runScwRound } from "./rebuildHook.js";
import { runSkillRound } from "./skillHook.js";
import { runMemoryRound } from "./memoryHook.js";
import {
  buildSpawnHandles,
  fillBuildOptions,
  makeAgentId,
  resolveToolPool,
  runPreflight,
} from "./runHelpers.js";

// ---------------------------------------------------------------------------
// Public surface (frozen at step-16 per architecture.md §3.3)
// ---------------------------------------------------------------------------

export type StopReason =
  | "final"
  | "maxRounds"
  | "cancelled"
  | "budgetExceeded";

export interface QueryRunOptions {
  /** Initial message list (caller owns; engine returns a *copy* + new msgs). */
  messages: ChatMessage[];
  /** System prompt builder inputs. Engine fills `context` from defaults if absent. */
  systemPromptOpts?: Partial<BuildOptions>;
  provider: ProviderId;
  model?: string;
  temperature?: number;
  maxTokens?: number;

  /** Override the default tool pool. Defaults to all registered tools. */
  tools?: Tool[];
  /** Token cap for ATP allocator. Defaults to 6000. */
  toolBudgetTokens?: number;
  /** Tool whitelist by name (intersection with `tools`). */
  toolAllowlist?: string[];
  /** Tool blacklist by name (subtracted from the pool). */
  toolDenylist?: string[];

  /** Permission mode override (else config). */
  permissionMode?: PermissionMode | string;
  /** Hook engine settings paths (else defaults). */
  hooksSettingsPaths?: string[];

  abortSignal?: AbortSignal;

  /** Sub-agent / swarm bookkeeping (step-18 / 20). */
  agentRole?: AgentRole;
  agentId?: string;
  parentId?: string;

  /** Budget hint for SCW (step-27/28). */
  contextBudget?: ContextBudget;

  /** Active goal objective (step-29 CSG input). Optional; goal loop sets it. */
  goalObjective?: string;

  /** step-29: caller-provided session bag (REPL passes a stable ref so
   *  manual skill activations / todos persist across runs). Frozen-extension. */
  session?: ToolSession;

  /** Hard cap on tool-call rounds; default 8. */
  maxRounds?: number;

  /** Hard cap on USD spend; default Infinity. */
  budgetUSD?: number;

  /** Grace period in ms for in-flight tools after an abort. Default 2000. */
  cancelGraceMs?: number;

  // Streaming / UI hooks
  onToken?(delta: string): void;
  onMessage?(msg: ChatMessage): void;
  onToolStart?(name: string, args: unknown): void;
  onToolEnd?(name: string, result: ToolResult): void;
  onUsage?(usage: TokenUsage): void;
  onHookMessage?(message: string): void;
  /**
   * step-27: per-round SCW snapshot. Fires once per `monitor.inspect()`
   * (i.e. once per provider call). Receivers (REPL HeaderBar) can read
   * `state.total / state.thresholds.ctxWindow` for the live ctx %.
   * Best-effort — exceptions are caught + warned.
   */
  onContextSnapshot?(state: MonitorState): void;

  // ToolContext extensions (CLI-supplied)
  askUser?: ToolContext["askUser"];
  askPermission?: ToolContext["askPermission"];
  isInteractive?: ToolContext["isInteractive"];
}

export interface QueryRunResult {
  finalContent: string;
  messages: ChatMessage[];
  costUSD: number;
  tokens: { in: number; out: number; cacheRead: number };
  rounds: number;
  stopReason: StopReason;
  /** PSF shapes captured per round (for `chovy prompt diff` later). */
  shapes: ReturnType<typeof computeShape>[];
}

export interface QueryEngineDeps {
  /** Optional injected logger (else module logger). */
  logger?: typeof logger;
  /** Optional override of the per-provider price table (CostTracker). */
  prices?: Record<string, import("./costTracker.js").ModelPrice>;
}

// Sub-agent / SwarmR builder hooks (step-18 / step-20). Registration storage
// lives in `runtimeRegistry.ts` (AGENTS.md §17 single-source); we re-export the
// setters so the engine barrel keeps a stable public API. The lookup side
// (`getSpawnFnBuilder` / `getDispatchFnBuilder`) is consumed inside
// `buildSpawnHandles` (`runHelpers.ts`) so the engine itself doesn't need
// to import them.
export {
  setSpawnFnBuilder,
  setDispatchFnBuilder,
  type SpawnFnBuilder,
  type DispatchFnBuilder,
} from "./runtimeRegistry.js";

// ---------------------------------------------------------------------------
// Engine class
// ---------------------------------------------------------------------------

export class QueryEngine {
  private readonly deps: QueryEngineDeps;

  constructor(deps: QueryEngineDeps = {}) {
    this.deps = deps;
  }

  async run(opts: QueryRunOptions): Promise<QueryRunResult> {
    const log = this.deps.logger ?? logger;
    const provider = getProvider(opts.provider);
    provider.assertReady();

    const config: ChovyConfig = loadConfig();
    const cwd = process.cwd();
    const model = opts.model ?? provider.info.defaultModel;
    const maxRounds = opts.maxRounds ?? 8;
    const budgetUSD = opts.budgetUSD ?? Infinity;
    const cancelGraceMs = opts.cancelGraceMs ?? 2000;

    const agentId = opts.agentId ?? makeAgentId();
    const role: AgentRole = opts.agentRole ?? "main";
    const sessionId = agentId;

    // Sub-agents must NOT share the parent's signal (AGENTS.md §9). Callers
    // pass an external signal here, but inside the engine we wrap it in a
    // local AbortController so we can also fire programmatic cancels (e.g.
    // budget breaches) without touching the caller's signal.
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) ac.abort();
      else opts.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    // Permission state per run (each sub-agent has its own breaker).
    const isInteractive =
      opts.isInteractive ?? (() => Boolean(process.stdin?.isTTY));
    const permState: PermissionEngineState = createPermissionEngineState(
      {
        mode: permissionModeFromString(opts.permissionMode ?? config.permissionMode),
        cwd,
        dontAsk: !isInteractive(),
      },
      log,
    );

    // Hook engine snapshot at construction (AGENTS.md §16: no mid-session
    // re-read). Sub-agents construct their own engine.
    const hookEngine = createHookEngine({
      cwd,
      sessionId,
      settingsPaths: opts.hooksSettingsPaths,
    });

    const session: ToolSession = opts.session ?? { todoList: [] };

    const messages: ChatMessage[] = [...opts.messages];

    // Sub-agent spawn factory (step-18) + SwarmR dispatch (step-20). Only
    // top-level `main` gets handles; helpers in `runHelpers.ts` bridge the
    // registry (avoids engine → swarm → agent → engine cycle).
    const handles = buildSpawnHandles({
      role,
      agentId,
      provider: opts.provider,
      model,
      mode: permState.mode,
      messages,
      signal: ac.signal,
    });
    const spawnFn: SpawnFn | undefined = handles.spawn;
    const dispatchSwarm: ToolContext["dispatchSwarm"] | undefined = handles.dispatch;

    // Build the runtime ToolContext once; round-level changes go through
    // `permState` / `hookEngine` not new ctx allocations.
    const ctx: ToolContext = {
      cwd,
      abortSignal: ac.signal,
      logger: log,
      permissions: {
        preflight: (toolName: string, args: unknown) =>
          runPreflight(toolName, args, ctx, permState),
      },
      hooks: {
        emit: (event: string, payload: unknown) => {
          return hookEngine.emit(event, payload).then((outcome) => {
            if (outcome.type === "block" && opts.onHookMessage) {
              opts.onHookMessage(`Hook ${event} blocked: ${outcome.reason}`);
            }
            return outcome;
          });
        },
        runPermissionRequest: (toolName: string, args: unknown, hctx: unknown) =>
          hookEngine.runPermissionRequest(
            toolName,
            args,
            hctx as HookContext,
          ),
      },
      spawnSubAgent: spawnFn,
      dispatchSwarm,
      config,
      sessionId,
      projectId: deriveProjectId(cwd),
      session,
      isInteractive: opts.isInteractive,
      askUser: opts.askUser,
      askPermission: opts.askPermission,
      // step-26: identify the agent's role to tools so they can do
      // role-aware checks (e.g. checkpoint-writer's path sandbox).
      agentRole: role,
    };

    const cost = new CostTracker({
      agentId,
      prices: this.deps.prices,
    });

    // Tool pool selection: callers may inject a custom subset (sub-agents do).
    const toolPool = resolveToolPool(opts);

    // ── SCW monitor (step-27). `createContextMonitorIfEnabled` honors
    //   `CHOVY_CTX_DISABLE=1` and degrades gracefully on init failure.
    //   Sub-agents share the env switch but get their own instance.
    const ctxMonitor: ContextMonitor | null = createContextMonitorIfEnabled({
      providerId: opts.provider,
      model,
      cfg: config,
      env: process.env,
      checkpoints: getCheckpointCoordinator(),
      cwd,
      threadId: sessionId,
      parentSignal: ac.signal,
      parentRole: role,
      getRecentMessages: () => messages.slice(-12),
      // step-23 will close this over its goal state when the engine is
      // invoked from the goal loop; ad-hoc runs leave it undefined.
      getObjective: () => undefined,
      getHistoryTail: () => [],
    });
    let pendingPressure: PressureSnippet | undefined;
    let pendingBudget: { used: number; total: number } | undefined;
    let memoryBannerShown = false;

    // Track for ATP relevance.
    let lastToolCalls: string[] = [];
    let prevToolCalls: string[] = [];

    let stopReason: StopReason = "maxRounds";
    let finalContent = "";
    const shapes: QueryRunResult["shapes"] = [];
    let endStatus = "done";

    emitTelemetry({
      type: "agent.start",
      agentId,
      role,
    });

    // Best-effort SessionStart hook (matches old agent.ts).
    try {
      if (ctx.hooks?.emit) {
        await ctx.hooks.emit("SessionStart", { extra: { source: "startup" } });
      }
    } catch (err) {
      log.warn("SessionStart hook threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let rounds = 0;
    try {
      for (rounds = 0; rounds < maxRounds; rounds++) {
        if (ac.signal.aborted) {
          stopReason = "cancelled";
          break;
        }
        if (cost.cumulativeTotal().usd >= budgetUSD) {
          stopReason = "budgetExceeded";
          log.warn("QueryEngine: budget exceeded", {
            usd: cost.cumulativeTotal().usd,
            cap: budgetUSD,
          });
          break;
        }

        // ── 0. CSG planner — step-29 ──────────────────────────────────────
        // Runs BEFORE prompt build so this round's prompt includes any
        // newly-activated `<skill>` blocks. Cap preserved via skillHook.ts.
        const skillRound = await runSkillRound({
          messages, session, agentRole: role, cwd, cfg: config,
          provider: opts.provider, model, goalObjective: opts.goalObjective,
        });
        const memoryRound = await runMemoryRound({
          messages, agentRole: role, cwd, cfg: config,
          goalObjective: opts.goalObjective,
          omitMemory: opts.systemPromptOpts?.agent?.omitMemory === true,
        });
        if (!memoryBannerShown && role === "main") {
          if (memoryRound.entries > 0) {
            log.info(`memory loaded: ${memoryRound.entries} entries`);
          } else if (rounds === 0 && config.memory.enabled) {
            log.info("memory empty: enable project memory with `chovy mem write \"...\"`");
          }
          memoryBannerShown = true;
        }

        // ── 1. system prompt ──────────────────────────────────────────────
        // step-27: pendingPressure / live ctx-budget arrive from the previous
        // round's monitor.inspect; the FIRST round always sees `fresh` since
        // the monitor hasn't run yet.
        const effective: EffectivePrompt = buildEffectiveSystemPrompt(
          fillBuildOptions(opts, {
            provider: opts.provider, model, cwd,
            planMode: permState.mode === "plan",
            pressure: pendingPressure, contextBudget: pendingBudget,
            memoryText: memoryRound.memoryText,
            loadedSkills: skillRound.loadedSkills,
            skillFragments: skillRound.skillFragments,
          }),
        );

        // ── 2. ATP describe tools ─────────────────────────────────────────
        const described: DescribedTool[] = describeTools({
          budgetTokens: opts.toolBudgetTokens ?? 6000,
          recentMessages: messages.slice(-8),
          lastToolCalls,
          prevToolCalls,
          agentRole: role,
          only: toolPool.map((t) => t.name),
        });

        // PSF telemetry — one shape per round. step-15 §验收标准 4 hooks here.
        // The shape is the real `PromptShape` from `src/prompts/fingerprint.ts`
        // (single-source per AGENTS.md §16); the placeholder shape that lived
        // in `telemetry/events.ts` was retired by step-15.
        const shape = computeShape(effective, described, model);
        shapes.push(shape);
        emitTelemetry({
          type: "prompt.shape",
          shape,
        });

        // ── 3. SCW — step-27 monitor + step-28 rebuild ───────────────────
        // `runScwRound` inspects ctx pressure, fires the rebuilder on a
        // hard transition (mutating `messages` in place + resetting the
        // monitor + splitting the cost session), and returns the next
        // round's prompt hints. Engine logic stays linear; SCW glue
        // lives in `rebuildHook.ts` per AGENTS.md §17 600-line cap.
        const scw = await runScwRound({
          monitor: ctxMonitor,
          messages,
          systemBytes: effective.text.length,
          cost,
          cwd,
          sessionId,
          provider: opts.provider,
          model,
          cfg: config,
          hooks: ctx.hooks,
          parentSignal: ac.signal,
          onSnapshot: opts.onContextSnapshot,
        });
        pendingPressure = scw.pressure;
        pendingBudget = scw.budget;

        // ── 4. normalize messages for provider ────────────────────────────
        const cleaned = pruneOrphanToolMessages(messages);
        const normalized = normalizeForProvider(cleaned, { provider: opts.provider });

        // ── 5. provider call (stream when possible) ───────────────────────
        if (ctx.hooks?.emit) {
          try {
            await ctx.hooks.emit("PreApiCall", {
              extra: { provider: opts.provider, model, tools: described.map((d) => d.name) },
            });
          } catch { /* best-effort */ }
        }

        const reqOpts = {
          model, messages: normalized, systemPrompt: effective.text,
          temperature: opts.temperature, maxTokens: opts.maxTokens,
          tools: described.map((d) => d.name),
          toolSpecs: described.map((d) => ({
            name: d.name, description: d.description,
            schemaJson: d.schemaJson, level: d.level,
          })),
        };

        const round = rounds; // capture for closures
        const stream = await runStream(provider, reqOpts, {
          abortSignal: ac.signal,
          onToken: opts.onToken
            ? (delta) => {
                if (ac.signal.aborted) return;
                try {
                  opts.onToken!(delta);
                } catch (err) {
                  log.warn("onToken callback threw", {
                    round,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            : undefined,
        });

        // ── 6. cost accounting ───────────────────────────────────────────
        if (stream.completion.usage) {
          const usage: TokenUsage = {
            in: stream.completion.usage.prompt,
            out: stream.completion.usage.completion,
          };
          cost.record(opts.provider, model, usage);
          opts.onUsage?.(usage);
        }

        // ── 7. push assistant turn ───────────────────────────────────────
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: stream.completion.content,
          toolCalls: stream.completion.toolCalls,
          ts: Date.now(),
        };
        messages.push(assistantMsg);
        opts.onMessage?.(assistantMsg);

        // Cancellation between assistant turn and tool dispatch.
        if (ac.signal.aborted || stream.aborted) {
          stopReason = "cancelled";
          finalContent = stream.completion.content;
          break;
        }

        if (!stream.completion.toolCalls || stream.completion.toolCalls.length === 0) {
          finalContent = stream.completion.content;
          stopReason = "final";
          break;
        }

        // ── 8. tool execution loop ───────────────────────────────────────
        prevToolCalls = lastToolCalls;
        lastToolCalls = stream.completion.toolCalls.map((c) => c.name);

        // Run tool calls in parallel within the same round; the harness
        // gates each one independently. Any tool seeing `ctx.abortSignal`
        // can short-circuit on its own.
        const toolMessages = await Promise.all(
          stream.completion.toolCalls.map((call) =>
            executeToolCall(call, ctx, permState, opts, cancelGraceMs),
          ),
        );
        for (const m of toolMessages) {
          messages.push(m);
          opts.onMessage?.(m);
        }
      }

      if (rounds >= maxRounds && stopReason === "maxRounds") {
        log.warn(`QueryEngine: hit maxRounds (${maxRounds}) without final answer`);
        endStatus = "max_rounds";
        finalContent = finalContent || "(no final answer — round limit reached)";
      } else if (stopReason === "cancelled") {
        endStatus = "cancelled";
      } else if (stopReason === "budgetExceeded") {
        endStatus = "budget_exceeded";
      }
    } catch (err) {
      endStatus = "failed";
      throw err;
    } finally {
      // SessionEnd hook — best-effort.
      if (ctx.hooks?.emit) {
        try {
          await ctx.hooks.emit("SessionEnd", { extra: { reason: endStatus } });
        } catch (err) {
          log.warn("SessionEnd hook threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const totals = cost.cumulativeTotal();
      emitTelemetry({
        type: "agent.end",
        agentId,
        status: endStatus,
        costUSD: totals.usd,
      });
      // Flush so short-lived CLI invocations land their telemetry on disk.
      await getTelemetrySink().flush();

      if (opts.abortSignal && !opts.abortSignal.aborted) {
        opts.abortSignal.removeEventListener("abort", onParentAbort);
      }
    }

    const totals = cost.cumulativeTotal();
    return {
      finalContent, messages, costUSD: totals.usd,
      tokens: { in: totals.tokensIn, out: totals.tokensOut, cacheRead: totals.cacheRead },
      rounds, stopReason, shapes,
    };
  }

  // Class-level helpers (resolveToolPool / fillBuildOptions / runPreflight /
  // makeAgentId) live in `runHelpers.ts` to keep this file under the §17
  // 600-line cap. Call sites use the module-level functions directly.
}
