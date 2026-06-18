import React from "react";
import { Box, Text } from "ink";

export interface HelpEntry {
  name: string;
  help: string;
}

interface Props {
  entries: HelpEntry[];
}

/**
 * Minimal floating help panel for /help. step-13 will let hooks contribute
 * extra rows (e.g. a registered SkillCommand); for now we just render the
 * static slash command table.
 */
export function HelpOverlay({ entries }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">slash commands</Text>
      {entries.map((e) => (
        <Box key={e.name}>
          <Box width={14}>
            <Text color="cyan">/{e.name}</Text>
          </Box>
          <Text dimColor>{e.help}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          Esc 取消运行 · Ctrl+C 二次退出 · Shift+Enter 换行
        </Text>
      </Box>
    </Box>
  );
}
