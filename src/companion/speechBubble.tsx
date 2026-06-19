import { useEffect, useState, memo } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import { wrapByDisplayWidth } from "../tui/stringWidth.js";
import type { CompanionState } from "./types.js";

export const SpeechBubble = memo(function SpeechBubble({ text, state }: { text: string; state: CompanionState }) {
  const theme = useTheme();
  const fg = state === "error" ? theme.error : state === "done" ? theme.success : theme.accent;
  const linesRaw = wrapByDisplayWidth(text, 30);
  const lines = linesRaw.slice(0, 3);
  
  const [fading, setFading] = useState(false);

  useEffect(() => {
    setFading(false);
    const t = setTimeout(() => setFading(true), 6000);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <Box flexDirection="column" marginRight={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={fg} paddingX={1} width={34}>
        {lines.map((l, i) => <Text key={i} italic color={fg} dimColor={fading}>{l}</Text>)}
      </Box>
      <Box paddingLeft={4}>
        <Text color={fg} dimColor>· · ·</Text>
      </Box>
    </Box>
  );
});
