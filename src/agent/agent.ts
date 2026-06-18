import { getProvider } from "../providers/index.js";
import { getTool } from "../tools/index.js";
import { logger } from "../logger/index.js";
import type {
  ChatMessage,
  ProviderId,
  ProviderRequestOptions,
  ToolCall,
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

  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

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
        messages.push({
          role: "tool",
          toolName: call.name,
          content: `Error: invalid arguments — ${parsed.error.message}`,
        });
        continue;
      }

      const output = await tool.run(parsed.data);
      messages.push({ role: "tool", toolName: call.name, content: output });
    }
  }

  logger.warn(`Agent hit maxRounds (${maxRounds}) without a final answer.`);
  return "(no final answer — round limit reached)";
}
