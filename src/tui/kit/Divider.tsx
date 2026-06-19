import { Box, Text } from 'ink';
import { useTheme } from '../../theme/index.js';
import { useTerminalCaps } from '../capabilities.js';

export interface DividerProps {
  label?: string;
  thick?: boolean;
}

export function Divider({ label, thick }: DividerProps) {
  const theme = useTheme();
  const caps = useTerminalCaps();
  const char = thick ? '━' : '─';
  const width = caps.cols > 0 ? caps.cols : 80;
  const line = char.repeat(width);

  if (label) {
    return (
      <Box flexDirection="row" width="100%" alignItems="center">
        <Text color={theme.muted}>{char.repeat(2)}</Text>
        <Box paddingX={1}>
          <Text color={theme.muted}>{label}</Text>
        </Box>
        <Box flexGrow={1} overflow="hidden">
           <Text color={theme.muted} wrap="truncate-end">{line}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box width="100%" overflow="hidden">
      <Text color={theme.muted} wrap="truncate-end">{line}</Text>
    </Box>
  );
}
