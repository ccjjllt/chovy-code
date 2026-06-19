import { Box, Text } from "ink";
import type { PaletteCommand } from "./state.js";
import type { MatchResult } from "./search.js";
import { HighlightedLabel } from "./highlight.js";

export function PaletteRow({ item, selected, result }: { item: PaletteCommand; selected: boolean; result: MatchResult }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        {selected && <Text inverse> </Text>}
        {selected ? (
          <Text inverse><HighlightedLabel text={item.label()} positions={result.positions} /></Text>
        ) : (
          <HighlightedLabel text={item.label()} positions={result.positions} />
        )}
      </Box>
      {item.hotkey ? <Text dimColor>{item.hotkey}</Text> : null}
    </Box>
  );
}
