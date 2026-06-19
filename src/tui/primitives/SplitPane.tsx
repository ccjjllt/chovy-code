import type { ReactNode } from "react";
import { Box } from "ink";
import { useTerminalSize } from "../capabilities";
import { Stack } from "./Stack";

export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  ratio: number;
  minLeft?: number;
  minRight?: number;
}

export function SplitPane({ left, right, ratio, minLeft = 20, minRight = 40 }: SplitPaneProps) {
  const { cols } = useTerminalSize();

  if (cols < minLeft + minRight) {
    return (
      <Stack width="100%">
        <Box width="100%" flexDirection="column">{left}</Box>
        <Box width="100%" flexDirection="column">{right}</Box>
      </Stack>
    );
  }

  const leftCols = Math.max(minLeft, Math.round(cols * ratio));

  return (
    <Box flexDirection="row" width="100%">
      <Box width={leftCols} flexDirection="column">
        {left}
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {right}
      </Box>
    </Box>
  );
}
