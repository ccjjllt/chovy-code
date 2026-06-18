/**
 * QueryEngine — the chovy-code core loop (step-16).
 *
 * Replaces the simple `runAgent` from `src/agent/agent.ts`. The legacy
 * function survives as a back-compat shim that constructs an engine and
 * forwards a single user prompt; everything new (sub-agents, swarm, goal
 * loop) calls `engine.run(opts)` directly.
 *
 * Pipeline per round (matches `docs/step-16-query-engine.md §主循环`):
 *
 *   1. assemble system prompt via `buildEffectiveSystemPrompt` (step-15);
 *   2. ATP-describe tools via `describeTools` (step-07);
 *   3. (TODO step-27/28) check SCW thresholds + rebuild;
 *   4. normalize message list for the active provider (step-17 wires the
 *      adapter; we always run the engine-side preprocess);
 *   5. emit `PreApiCall` hook + run provider (`stream` if available);
 *   6. record cost via `CostTracker`;
 *   7. push the assistant turn; if no tool calls → finalize;
 *   8. for every tool call: hook PreToolUse → permission gate → `tool.run`
 *      → hook PostToolUse → push tool message;
 *   9. honor abort: between rounds, between tool calls, and inside the
 *      provider stream (signal forwarded from `runStream`).
 *
 * Cancellation is best-effort: a single Esc / Ctrl+C aborts the signal
 * we forward into the provider; long-running tools see the same signal on
 * `ctx.abortSignal`. We wait at most `cancelGraceMs` for in-flight tools
 * to settle before returning `stopReason: 'cancelled'`.
 *
 * Design constraints (AGENTS.md §16 + §17):
 *   - Single source for `tool.call` telemetry stays in this file (the
 *     wrapper around `tool.run`); tools MUST NOT emit it themselves.
 *   - Sub-agents create their *own* AbortController (we accept any
 *     external `abortSignal` here but never share one across runs).
 *   - The frozen `PermissionEngine.preflight?` adapter on `ToolContext`
 *     binds `hasPermission` to live state; engine never touches globals.
 */

import type { ZodType } from "zod";
import { logger } from "../logger/index.js";
import { emitTelemetry, getTelemetrySink } from "../telemetry/index.js";
import { loadConfig, type ChovyConfig, type PermissionMode } from "../config/index.js";
import { projectId as deriveProjectId } from "../fs/paths.js";
import { getTool, listTools, describeTools } from "../tools/index.js";
import type { DescribedTool } from "../tools/index.js";
import { getProvider } from "../providers/index.js";
import {
  buildEffectiveSystemPrompt,
  computeShape,
  type BuildOptions,
  type EffectivePrompt,
} from "../prompts/index.js";
import {
  createPermissionEngineState,
  hasPermission,
  permissionModeFromString,
  type PermissionEngineState,
} from "../harness/permissions/index.js";
import { createHookEngine } from "../harness/hooks/index.js";
import type { HookContext } from "../harness/hooks/index.js";
import type {
  AgentRole,
  ChatMessage,
  ContextBudget,
  PermissionPreflight,
  ProviderId,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSession,
} from "../types/index.js";
import { CostTracker, type TokenUsage } from "./costTracker.js";
import { normalizeForProvider, pruneOrphanToolMessages } from "./messageNormalize.js";
import { runStream } from "./streamHandler.js";

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

  // ToolContext extensions (CLI-supplied)
  askUser?: ToolContext["askUser"];
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

    const session: ToolSession = { todoList: [] };

    // Build the runtime ToolContext once; round-level changes go through
    // `permState` / `hookEngine` not new ctx allocations.
    const ctx: ToolContext = {
      cwd,
      abortSignal: ac.signal,
      logger: log,
      permissions: {
        preflight: (toolName: string, args: unknown) =>
          this.runPreflight(toolName, args, ctx, permState),
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
      config,
      sessionId,
      projectId: deriveProjectId(cwd),
      session,
      askUser: opts.askUser,
      isInteractive,
    };

    const cost = new CostTracker({
      agentId,
      prices: this.deps.prices,
    });

    // Tool pool selection: callers may inject a custom subset (sub-agents do).
    const toolPool = this.resolveToolPool(opts);

    const messages: ChatMessage[] = [...opts.messages];

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
        if (cost.total().usd >= budgetUSD) {
          stopReason = "budgetExceeded";
          log.warn("QueryEngine: budget exceeded", {
            usd: cost.total().usd,
            cap: budgetUSD,
          });
          break;
        }

        // ── 1. system prompt ──────────────────────────────────────────────
        const effective: EffectivePrompt = buildEffectiveSystemPrompt(
          this.fillBuildOptions(opts, {
            provider: opts.provider,
            model,
            cwd,
            planMode: permState.mode === "plan",
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

        // ── 3. SCW (TODO step-27/28) ──────────────────────────────────────
        // The monitor lives under `src/context/`; until it lands we just
        // assume the conversation fits. The engine surface accepts a
        // `contextBudget` hint already so the integration is additive.

        // ── 4. normalize messages for provider ────────────────────────────
        const cleaned = pruneOrphanToolMessages(messages);
        const normalized = normalizeForProvider(cleaned, {
          provider: opts.provider,
        });

        // ── 5. provider call (stream when possible) ───────────────────────
        if (ctx.hooks?.emit) {
          try {
            await ctx.hooks.emit("PreApiCall", {
              extra: {
                provider: opts.provider,
                model,
                tools: described.map((d) => d.name),
              },
            });
          } catch { /* best-effort */ }
        }

        const reqOpts = {
          model,
          messages: normalized,
          systemPrompt: effective.text,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          tools: described.map((d) => d.name),
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
            this.executeToolCall(call, ctx, permState, opts, cancelGraceMs),
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
      const totals = cost.total();
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

    const totals = cost.total();
    return {
      finalContent,
      messages,
      costUSD: totals.usd,
      tokens: {
        in: totals.tokensIn,
        out: totals.tokensOut,
        cacheRead: totals.cacheRead,
      },
      rounds,
      stopReason,
      shapes,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Adapter that satisfies `PermissionEngine.preflight?`. */
  private async runPreflight(
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

  private resolveToolPool(opts: QueryRunOptions): Tool[] {
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

  private fillBuildOptions(
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

  /**
   * Run a single tool call: hook → permission → schema parse → run →
   * post-hook. Returns the `tool` ChatMessage to push onto the transcript.
   *
   * Telemetry: emits exactly one `tool.call` event (single source per
   * AGENTS.md §17). Hook failures are advisory and never poison the tool
   * result.
   */
  private async executeToolCall(
    call: ToolCall,
    ctx: ToolContext,
    permState: PermissionEngineState,
    opts: QueryRunOptions,
    cancelGraceMs: number,
  ): Promise<ChatMessage> {
    const tool = getTool(call.name);
    if (!tool) {
      logger.warn(`Unknown tool requested: ${call.name}`);
      emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
      return {
        role: "tool",
        toolName: call.name,
        content: `Error: unknown tool "${call.name}"`,
        ts: Date.now(),
      };
    }

    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      args = {};
    }
    opts.onToolStart?.(call.name, args);

    const parsed = (tool.schema as ZodType).safeParse(args);
    if (!parsed.success) {
      emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
      const message = `Error: invalid arguments — ${parsed.error.message}`;
      opts.onToolEnd?.(call.name, { ok: false, content: message, errorCode: "TOOL_DENIED" });
      return {
        role: "tool",
        toolName: call.name,
        content: message,
        ts: Date.now(),
      };
    }

    // PreToolUse hook: a `block` outcome short-circuits.
    if (ctx.hooks?.emit) {
      try {
        const pre = await ctx.hooks.emit("PreToolUse", {
          toolName: call.name,
          toolArgs: parsed.data,
        });
        if (pre.type === "block") {
          emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
          const message = `Blocked by PreToolUse hook: ${pre.reason}`;
          opts.onToolEnd?.(call.name, {
            ok: false,
            content: message,
            errorCode: "TOOL_DENIED",
          });
          return {
            role: "tool",
            toolName: call.name,
            content: message,
            ts: Date.now(),
          };
        }
      } catch (err) {
        logger.warn("PreToolUse hook threw", {
          tool: call.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 6-layer permission engine.
    const decision = await hasPermission(tool, parsed.data, ctx, permState);
    if (decision.outcome !== "allow") {
      emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
      if (ctx.hooks?.emit && decision.outcome === "deny") {
        try {
          await ctx.hooks.emit("PermissionDenied", {
            toolName: call.name,
            toolArgs: parsed.data,
            error: decision.reason,
          });
        } catch { /* swallowed inside emit; defensive */ }
      }
      const message =
        decision.outcome === "deny"
          ? `Permission denied: ${decision.reason}`
          : `Permission pending (ask): ${decision.reason}`;
      opts.onToolEnd?.(call.name, {
        ok: false,
        content: message,
        errorCode: "TOOL_DENIED",
      });
      return {
        role: "tool",
        toolName: call.name,
        content: message,
        ts: Date.now(),
      };
    }

    const startedAt = Date.now();
    let ok = true;
    let output: string;
    let toolResult: ToolResult;
    try {
      const raw = await this.invokeTool(tool, parsed.data, ctx, cancelGraceMs);
      if (typeof raw === "string") {
        output = raw;
        toolResult = { ok: true, content: raw };
      } else {
        ok = raw.ok;
        output = raw.content;
        toolResult = raw;
      }
    } catch (err) {
      ok = false;
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      toolResult = { ok: false, content: output, errorCode: "INTERNAL" };
    }
    emitTelemetry({
      type: "tool.call",
      tool: call.name,
      ok,
      durMs: Date.now() - startedAt,
    });

    if (ctx.hooks?.emit) {
      try {
        if (ok) {
          await ctx.hooks.emit("PostToolUse", {
            toolName: call.name,
            toolArgs: parsed.data,
            result: output,
          });
        } else {
          await ctx.hooks.emit("PostToolUseFailure", {
            toolName: call.name,
            toolArgs: parsed.data,
            error: output,
          });
        }
      } catch (err) {
        logger.warn("PostToolUse hook threw", {
          tool: call.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    opts.onToolEnd?.(call.name, toolResult);
    return {
      role: "tool",
      toolName: call.name,
      content: output,
      ts: Date.now(),
    };
  }

  /**
   * Invoke the tool with a soft cancel-grace window: if the abort signal
   * fires while the tool is running, we wait at most `cancelGraceMs` for
   * it to return on its own (most v2 tools observe `ctx.abortSignal`),
   * then surface a synthesized "cancelled" result. We never force-kill
   * the JS task — any kill semantics live inside the tool (e.g. the bash
   * tool's killTree).
   */
  private async invokeTool(
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
    cancelGraceMs: number,
  ): Promise<string | ToolResult> {
    const exec = Promise.resolve(tool.run(args, ctx));
    if (!ctx.abortSignal) return exec;

    return await new Promise<string | ToolResult>((resolve, reject) => {
      let settled = false;
      const settle = (cb: () => void): void => {
        if (settled) return;
        settled = true;
        cb();
      };
      const onAbort = (): void => {
        // Give the tool `cancelGraceMs` to return; otherwise return a
        // structured cancellation result. Don't reject — callers expect a
        // ToolResult so the message list stays consistent.
        const t = setTimeout(() => {
          settle(() =>
            resolve({
              ok: false,
              content: "Tool cancelled by user (timed out waiting for graceful exit).",
              errorCode: "INTERNAL",
            }),
          );
        }, cancelGraceMs);
        // Race: if the tool *does* finish during the grace window, the
        // exec.then below will settle first.
        exec.finally(() => clearTimeout(t));
      };
      if (ctx.abortSignal.aborted) onAbort();
      else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      exec.then(
        (v) => settle(() => resolve(v)),
        (e) => settle(() => reject(e)),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `agt_${g.crypto.randomUUID()}`;
  return `agt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
