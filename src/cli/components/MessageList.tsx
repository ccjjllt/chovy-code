import React, { useState, useEffect } from "react";
import { Box, useInput } from "ink";
import type { ToolResultMeta } from "../../types/index.js";
import { selectVisible, clampScrollTop } from "./messageListState.js";
import { MessageRow } from "./MessageRow.js";

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
  
  // Metadata for tool messages (step-54)
  toolArgs?: unknown;
  toolResultMeta?: ToolResultMeta;
  toolErrorCode?: string;
}

interface Props {
  messages: UIMessage[];
}

/**
 * MessageList with virtualization (step-54).
 */
export function MessageList({ messages }: Props): React.ReactElement {
  const [scrollTop, setScrollTop] = useState(0);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    setScrollTop(Math.max(0, messages.length - 30));
  }, [messages.length]);

  useInput((_input, key) => {
    if (key.pageUp) {
      setScrollTop((s) => clampScrollTop(s - 10, messages.length));
    }
    if (key.pageDown) {
      setScrollTop((s) => clampScrollTop(s + 10, messages.length));
    }
  });

  const visible = selectVisible(messages, scrollTop);

  return (
    <Box flexDirection="column" gap={1}>
      {visible.map((m) => (
        <MessageRow key={m.id} msg={m} />
      ))}
    </Box>
  );
}
