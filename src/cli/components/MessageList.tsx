import React from "react";
import { Box, Text } from "ink";

export type UIRole = "user" | "assistant" | "tool" | "system";

export interface UIMessage {
  id: string;
  role: UIRole;
  content: string;
  /** Streaming in progress — visual cue, not semantically different. */
  pending?: boolean;
  /** User cancelled the assistant turn that produced this message. */
  interrupted?: boolean;
  /** Set on tool-role messages. */
  toolName?: string;
}

interface Props {
  messages: UIMessage[];
}

const ROLE_GLYPH: Record<UIRole, { glyph: string; color: string }> = {
  user: { glyph: "❯", color: "cyan" },
  assistant: { glyph: "✦", color: "white" },
  tool: { glyph: "⚙", color: "magenta" },
  system: { glyph: "•", color: "gray" },
};

/**
 * Linear, append-only message list. Step-22 will replace this with a
 * virtualised version once the swarm UI lands; keeping it intentionally
 * dumb here so step-05's REPL has something to render today.
 */
export function MessageList({ messages }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      {messages.map((m) => {
        const meta = ROLE_GLYPH[m.role];
        const label = m.role === "tool" && m.toolName
          ? `${meta.glyph} ${m.toolName}`
          : meta.glyph;
        return (
          <Box key={m.id} flexDirection="column">
            <Box>
              <Text color={meta.color} bold>{label}</Text>
              {m.pending ? <Text dimColor>{"  …"}</Text> : null}
              {m.interrupted ? (
                <Text color="yellow">{"  [interrupted]"}</Text>
              ) : null}
            </Box>
            <Box paddingLeft={2}>
              <Text>{m.content}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
