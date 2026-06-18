/** A single chat message in the normalized, provider-agnostic format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present when role === "tool": the name of the tool that produced this output. */
  toolName?: string;
  /** Present when role === "assistant": tool calls the model requested. */
  toolCalls?: ToolCall[];
}

/** A tool call requested by the model. */
export interface ToolCall {
  /** Provider-assigned id, echoed back when reporting results. */
  id: string;
  name: string;
  /** Raw JSON string of arguments; the tool layer parses it. */
  arguments: string;
}

/** The normalized result of a tool invocation. */
export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
}

/** Non-streaming completion result. */
export interface ChatCompletion {
  content: string;
  toolCalls: ToolCall[];
  /** Token usage if the provider reports it. */
  usage?: { prompt: number; completion: number };
}
