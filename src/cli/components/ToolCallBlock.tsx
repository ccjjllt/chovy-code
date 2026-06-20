import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { t } from "../../i18n/index.js";
import { loadConfig } from "../../config/index.js";
import { useTheme } from "../../theme/index.js";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export interface ToolCallBlockProps {
  name: string;
  argsBrief: string;
  resultMeta?: { ok: boolean; bytes?: number; durMs?: number; errorCode?: string };
  fullArgs?: string;
  fullOutput?: string;
  focused?: boolean;
}

export function ToolCallBlock({ name, argsBrief, resultMeta, fullArgs, fullOutput, focused }: ToolCallBlockProps): React.ReactElement {
  const config = loadConfig();
  const defaultOpen = name === "shell" || name === "bash"
    ? config.general?.shellToolPartsExpanded
    : config.general?.editToolPartsExpanded;
    
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const theme = useTheme();
  
  useInput((_input, key) => {
    if (key.return) setOpen(o => !o);
  }, { isActive: Boolean(focused) });
  
  const dot = resultMeta?.ok === false ? <Text color={theme.error}>✗</Text> : <Text color={theme.success}>✓</Text>;
  const dur = resultMeta?.durMs ? `${resultMeta.durMs}ms` : "-";
  const sz  = resultMeta?.bytes !== undefined ? `${formatBytes(resultMeta.bytes)}` : "-";
  
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{open ? "▼ " : "▶ "}</Text>
        <Text bold color={focused ? theme.primary : theme.accent}>{name}</Text>
        <Text dimColor>{`(${argsBrief}) → `}</Text>
        {dot}
        <Text dimColor>{`  ${dur} · ${sz}`}</Text>
      </Box>
      {open ? (
        <Box paddingLeft={2} flexDirection="column">
          {resultMeta?.errorCode ? (
            <Text dimColor>{t("msg.tool.errorCode", { code: resultMeta.errorCode })}</Text>
          ) : null}
          {fullArgs ? <Text dimColor>Args: {fullArgs}</Text> : null}
          {fullOutput ? <Text dimColor>Output: {fullOutput.slice(0, 500)}{fullOutput.length > 500 ? "..." : ""}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
