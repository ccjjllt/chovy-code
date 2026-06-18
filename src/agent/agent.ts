import { getProvider } from "../providers/index.js";
import { getTool } from "../tools/index.js";
import { logger } from "../logger/index.js";
import { emitTelemetry, getTelemetrySink } from "../telemetry/index.js";
import { loadConfig } from "../config/index.js";
import { projectId as deriveProjectId } from "../fs/paths.js";
import type {
  ChatMessage,
  ProviderId,
  ProviderRequestOptions,
  ToolCall,
  ToolContext,
  ToolSession,
} from "../types/index.js";
import {
  createPermissionEngineState,
  hasPermission,
  permissionModeFromString,
  type PermissionEngineState,
} from "../harness/permissions/index.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are chovy-code, a coding agent. Answer concisely. " +
  "When a task needs action, call one of the provided tools.";

export interface AgentOptions {
  provider: ProviderId;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Cap on tool-call rounds per `run()` to avoid runaway loops. */
  maxRounds?: number;
  /** Called for every assistant token (streaming UI). */
  onToken?: (delta: string) => void;
  /** Called whenever the agent executes a tool. */
  onToolCall?: (name: string, args: unknown) => void;
  /**
   * External abort hook — when the host (CLI / REPL) wants to interrupt, it
   * aborts this signal. The agent loop forwards it to tools through
   * `ToolContext.abortSignal` so long-running ops (bash / web_fetch) cancel.
   * Step-16 will expand this into a full cancellation pipeline.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional `ask_user_question` callback supplied by the UI (step-22). When
   * absent the meta tool refuses with `INTERNAL` pointing at step-22.
   */
  askUser?: ToolContext["askUser"];
  /** Honors `process.stdin.isTTY` by default; UI may override. */
  isInteractive?: ToolContext["isInteractive"];
  /**
   * Permission mode for this run (step-12). Defaults to `config.permissionMode`.
   * The CLI resolves it from `--permission-mode` / env / config and passes it
   * here; sub-agents (step-18) pass their own mode.
   */
  permissionMode?: string;
}

/**
 * The core agent loop. Given a prompt, it:
 *   1. asks the provider for a completion
 *   2. if the model requested tool calls, runs them and feeds results back
 *   3. repeats until the model answers without tool calls (or maxRounds hit)
 *
 * Returns the assistant's final textual answer.
 */

/**
 * Adapter that satisfies the frozen `PermissionEngine.preflight?` handle on
 * `ToolContext.permissions` (step-06) by delegating to the step-12 6-layer
 * engine. Tools that call `ctx.permissions.preflight(name, args)` get the
 * same decision the agent loop uses. The handle returns the lighter
 * `PermissionPreflight` shape ({outcome, reason?, matchedRule?}).
 *
 * Defined at module scope so it closes over `getTool` without re-creating
 * the closure per run; `permState`/`ctx` are passed in.
 */
async function runPreflight(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
  permState: PermissionEngineState,
): Promise<import("../types/index.js").PermissionPreflight> {
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

export async function runAgent(prompt: string, opts: AgentOptions): Promise<string> {
  const provider = getProvider(opts.provider);
  provider.assertReady();

  const model = opts.model ?? provider.info.defaultModel;
  const maxRounds = opts.maxRounds ?? 8;

  // TODO step-18: replace with proper SubAgentHandle id from lifecycle.ts.
  const agentId = makeAgentId();
  // TODO step-16: costUSD should come from costTracker; 0 is a placeholder.
  let costUSD = 0;
  let endStatus = "done";

  emitTelemetry({ type: "agent.start", agentId, role: "main" });

  // Step-11 / step-16 prep: assemble a minimal ToolContext now so the v2
  // tools (bash / web_fetch / ask_user_question / agent / todo_write) can
  // honor abortSignal, ctx.session, ctx.askUser, etc. Step-16 owns the full
  // wiring (memory, hooks); step-12 wires the real permission engine here.
  // Sub-agents get their OWN AbortController per AGENTS.md §9.
  const cwd = process.cwd();
  const config = loadConfig();
  const session: ToolSession = { todoList: [] };
  const isInteractive =
    opts.isInteractive ?? (() => Boolean(process.stdin?.isTTY));

  // Step-12 permission engine. The mode is resolved from the explicit option
  // (CLI/REPL) or falls back to the config default. `dontAsk` mirrors the
  // non-interactive flag so a one-shot `chat "..."` / sub-agent converts ask
  // outcomes to deny instead of deadlocking on a prompt that never comes.
  const permState: PermissionEngineState = createPermissionEngineState(
    {
      mode: permissionModeFromString(opts.permissionMode ?? config.permissionMode),
      cwd,
      dontAsk: !isInteractive(),
    },
    logger,
  );

  const ctx: ToolContext = {
    cwd,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    logger,
    // step-12: real engine. The frozen `PermissionEngine.preflight?` handle
    // delegates to `hasPermission` against the live `permState` below.
    permissions: {
      preflight: (toolName: string, args: unknown) =>
        runPreflight(toolName, args, ctx, permState),
    },
    hooks: {},
    config,
    sessionId: agentId,
    projectId: deriveProjectId(cwd),
    session,
    askUser: opts.askUser,
    isInteractive,
  };

  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

  try {
    for (let round = 0; round < maxRounds; round++) {
      const reqOpts: ProviderRequestOptions = {
        model,
        messages,
        systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      };

      // Prefer streaming when the provider supports it and the caller wants tokens.
      let completion;
      if (provider.stream && opts.onToken) {
        for await (const chunk of provider.stream(reqOpts)) {
          if (typeof chunk === "string") opts.onToken(chunk);
          else completion = chunk;
        }
      } else {
        completion = await provider.complete(reqOpts);
      }

      if (!completion) throw new Error("Provider returned no completion");

      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      if (completion.toolCalls.length === 0) {
        return completion.content;
      }

      // Execute each tool call and append results.
      for (const call of completion.toolCalls as ToolCall[]) {
        const tool = getTool(call.name);
        if (!tool) {
          logger.warn(`Unknown tool requested: ${call.name}`);
          emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
          messages.push({
            role: "tool",
            toolName: call.name,
            content: `Error: unknown tool "${call.name}"`,
          });
          continue;
        }

        let args: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }
        opts.onToolCall?.(call.name, args);

        const parsed = tool.schema.safeParse(args);
        if (!parsed.success) {
          emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
          messages.push({
            role: "tool",
            toolName: call.name,
            content: `Error: invalid arguments — ${parsed.error.message}`,
          });
          continue;
        }

        // Step-12 permission gate: run the 6-layer engine before executing.
        // `deny` (rules / safety / non-interactive ask) short-circuits the
        // tool with a `TOOL_DENIED` result; `ask` in an interactive session
        // would delegate to `ctx.askUser` once step-22 lands — today an ask
        // outcome resolves to deny here because the engine already converts
        // ask→deny when `isInteractive()` is false or `askUser` is absent.
        const permDecision = await hasPermission(tool, parsed.data, ctx, permState);
        if (permDecision.outcome === "deny") {
          const startedAt = Date.now();
          emitTelemetry({
            type: "tool.call",
            tool: call.name,
            ok: false,
            durMs: Date.now() - startedAt,
          });
          messages.push({
            role: "tool",
            toolName: call.name,
            content: `Permission denied: ${permDecision.reason}`,
          });
          continue;
        }
        if (permDecision.outcome === "ask") {
          // Reachable once step-22 wires ctx.askUser; the engine returns
          // `ask` only in interactive contexts. Until then it resolves to
          // deny inside the engine, so this branch is a forward-compat
          // placeholder that treats an unresolved ask as a denial.
          const startedAt = Date.now();
          emitTelemetry({
            type: "tool.call",
            tool: call.name,
            ok: false,
            durMs: Date.now() - startedAt,
          });
          messages.push({
            role: "tool",
            toolName: call.name,
            content: `Permission pending (ask): ${permDecision.reason}`,
          });
          continue;
        }

        const startedAt = Date.now();
        let ok = true;
        let output: string;
        try {
          // step-06 back-compat: tool.run may return either a legacy string
          // or a v2 ToolResult; we wrap strings and read `.content` from
          // structured results. We pass the minimal ToolContext assembled
          // above so v2 tools that need abortSignal / session / askUser see
          // them today (step-16 will swap in the full engine-aware ctx).
          const raw = await tool.run(parsed.data, ctx);
          if (typeof raw === "string") {
            output = raw;
          } else {
            ok = raw.ok;
            output = raw.content;
          }
        } catch (err) {
          ok = false;
          output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        emitTelemetry({
          type: "tool.call",
          tool: call.name,
          ok,
          durMs: Date.now() - startedAt,
        });
        messages.push({ role: "tool", toolName: call.name, content: output });
      }
    }

    logger.warn(`Agent hit maxRounds (${maxRounds}) without a final answer.`);
    endStatus = "max_rounds";
    return "(no final answer — round limit reached)";
  } catch (err) {
    endStatus = "failed";
    throw err;
  } finally {
    emitTelemetry({ type: "agent.end", agentId, status: endStatus, costUSD });
    // Short-lived CLI runs need an explicit flush so the JSONL file is on
    // disk before the process exits.
    await getTelemetrySink().flush();
  }
}

function makeAgentId(): string {
  // crypto.randomUUID is available in Bun + modern Node; fall back to a
  // timestamp + random suffix in unlikely environments without it.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `agt_${g.crypto.randomUUID()}`;
  return `agt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
