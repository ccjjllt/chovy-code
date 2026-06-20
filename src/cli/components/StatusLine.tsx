import React from "react";
import { Text } from "ink";
import { Spinner } from "../../tui/kit/index.js";

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

interface Props {
  status: AgentStatus;
  /** Active tool name, when status === "tool". */
  tool?: string;
}

const LABEL: Record<AgentStatus, string> = {
  idle: "·",
  thinking: "thinking",
  tool: "running tool",
  done: "✓ done",
  error: "✗ error",
};

/** Compact one-line status indicator shown while the agent works. */
export function StatusLine({ status, tool }: Props): React.ReactElement {
  const suffix = status === "tool" && tool ? ` (${tool})` : "";
  const color =
    status === "error" ? "red" : status === "done" ? "green" : "cyan";
    
  if (status === "thinking" || status === "tool") {
    return <Spinner label={`${LABEL[status]}${suffix}`} />;
  }

  return (
    <Text color={color} bold>
      {LABEL[status]}
      {suffix}
    </Text>
  );
}
