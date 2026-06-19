
import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import type { PaletteCommand } from "./state.js";

export function PaletteRow({ item, selected }: { item: PaletteCommand; selected: boolean }) {
  const theme = useTheme();
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text inverse={selected} color={selected ? theme.accent : undefined}>{item.label()}</Text>
      {item.hotkey ? <Text dimColor>{item.hotkey}</Text> : null}
    </Box>
  );
}
