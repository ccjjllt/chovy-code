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
}

/**
 * The core agent loop. Given a prompt, it:
 *   1. asks the provider for a completion
 *   2. if the model requested tool calls, runs them and feeds results back
 *   3. repeats until the model answers without tool calls (or maxRounds hit)
 *
 * Returns the assistant's final textual answer.
 */
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
  // wiring (memory, hooks, real permission engine); until then we provide
  // the fields each meta/exec/web tool actually checks. Sub-agents get
  // their OWN AbortController per AGENTS.md §9.
  const cwd = process.cwd();
  const config = loadConfig();
  const session: ToolSession = { todoList: [] };
  const ctx: ToolContext = {
    cwd,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    logger,
    // step-12 will replace these placeholder objects with the real engines.
    permissions: {},
    hooks: {},
    config,
    sessionId: agentId,
    projectId: deriveProjectId(cwd),
    session,
    askUser: opts.askUser,
    isInteractive: opts.isInteractive ?? (() => Boolean(process.stdin?.isTTY)),
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
