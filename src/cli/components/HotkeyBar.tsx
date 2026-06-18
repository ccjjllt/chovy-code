import React from "react";
import { Box, Text } from "ink";

interface Props {
  /** When true, show the detail-overlay hotkey set instead of the list set. */
  detailMode?: boolean;
}

/**
 * One-line hotkey legend rendered at the bottom of the SwarmPanel. Matches
 * `docs/step-22-agent-ui.md §快捷键` + the detail overlay's `[c] [s] [Esc]`.
 * Kept as static text (no interactivity) — the panel owns the `useInput`.
 */
export function HotkeyBar({ detailMode }: Props): React.ReactElement {
  if (detailMode) {
    return (
      <Box>
        <Text dimColor>
          {"[c] cancel  [s] save snapshot  [Esc] back"}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor>
        {"[↑/↓] select  [x] cancel  [Enter] details  [Tab] focus input  [Esc] close"}
      </Text>
    </Box>
  );
}
