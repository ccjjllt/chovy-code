import React from 'react';
import { Text } from 'ink';
import { useTheme } from '../../theme/index.js';

export type BadgeVariant = "success" | "warning" | "error" | "info" | "accent" | "muted";

export interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  const theme = useTheme();
  const isNoTui = process.env.CHOVY_NO_TUI === '1';

  if (isNoTui) {
    return <Text>[{children}]</Text>;
  }

  let color = theme.fg;
  switch (variant) {
    case "success": color = theme.success; break;
    case "warning": color = theme.warning; break;
    case "error": color = theme.error; break;
    case "info": color = theme.primary; break;
    case "accent": color = theme.accent; break;
    case "muted": color = theme.muted; break;
  }

  return (
    <Text color={color} inverse>
      {' '}{children}{' '}
    </Text>
  );
}
