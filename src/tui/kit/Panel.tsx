import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/index.js';
import { Spacer } from './Spacer.js';

export interface PanelProps {
  title?: string;
  titleRight?: string;
  borderColor?: string;
  focused?: boolean;
  minWidth?: number;
  minHeight?: number;
  children: React.ReactNode;
}

export function Panel({ title, titleRight, borderColor, focused, minWidth, minHeight, children }: PanelProps) {
  const theme = useTheme();
  const color = focused ? theme.accent : (borderColor ?? theme.primary);
  const isNoTui = process.env.CHOVY_NO_TUI === '1';

  if (isNoTui) {
    return (
      <Box flexDirection="column" minWidth={minWidth} minHeight={minHeight}>
        {(title || titleRight) ? (
          <Box justifyContent="space-between">
            {title ? <Text bold>{title}</Text> : <Spacer />}
            {titleRight ? <Text dimColor>{titleRight}</Text> : null}
          </Box>
        ) : null}
        {children}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle={theme.borderStyle} borderColor={color} paddingX={1} minWidth={minWidth} minHeight={minHeight}>
      {(title || titleRight) ? (
        <Box justifyContent="space-between">
          {title ? <Text bold color={color}>{title}</Text> : <Spacer />}
          {titleRight ? <Text dimColor>{titleRight}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}
