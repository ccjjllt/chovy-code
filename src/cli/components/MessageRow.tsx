import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../theme/index.js";
import { CollapsibleText } from "./CollapsibleText.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import type { UIMessage } from "./MessageList.js";

function parseToolMeta(msg: UIMessage) {
  const argsBrief = typeof msg.toolArgs === "object" && msg.toolArgs !== null
    ? JSON.stringify(msg.toolArgs).slice(0, 40) + "..."
    : String(msg.toolArgs || "{}").slice(0, 40);
  
  return {
    name: msg.toolName || "unknown",
    argsBrief,
    resultMeta: {
      ok: msg.toolErrorCode === undefined,
      bytes: msg.toolResultMeta?.bytes,
      durMs: msg.toolResultMeta?.durMs,
      errorCode: msg.toolErrorCode
    },
    fullArgs: JSON.stringify(msg.toolArgs, null, 2),
    fullOutput: msg.content
  };
}

function MessageRowInner({ msg }: { msg: UIMessage }) {
  const theme = useTheme();
  
  const prefix = msg.role === "user"      ? <Text color={theme.accent} bold>›</Text>
              : msg.role === "assistant" ? <Text color={theme.primary} bold>chovy</Text>
              : msg.role === "tool"      ? null
              : <Text dimColor>·</Text>;

  if (msg.role === "tool") {
    return <ToolCallBlock {...parseToolMeta(msg)} />;
  }

  return (
    <Box flexDirection="row">
      <Box marginRight={1}>{prefix}</Box>
      <Box flexGrow={1}>
        {msg.role === "assistant" && msg.content.length > 0
          ? <CollapsibleText text={msg.content} />
          : <Text dimColor={msg.role === "system"}>{msg.content || (msg.pending ? "…" : "")}</Text>}
      </Box>
    </Box>
  );
}

export const MessageRow = React.memo(MessageRowInner, (prev, next) => {
  return prev.msg.id === next.msg.id && 
         prev.msg.content === next.msg.content && 
         prev.msg.pending === next.msg.pending;
});
