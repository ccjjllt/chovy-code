import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/index.js';

export interface SpinnerProps {
  label?: string;
  intervalMs?: number;
}

export function Spinner({ label, intervalMs = 100 }: SpinnerProps) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % theme.spinnerFrames.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, theme.spinnerFrames.length]);
  
  return (
    <Box>
      <Text color={theme.accent}>{theme.spinnerFrames[frame]}</Text>
      {label ? <Text> {label}</Text> : null}
    </Box>
  );
}
