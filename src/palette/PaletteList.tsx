
import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import { t } from "../i18n/index.js";
import { PaletteRow } from "./PaletteRow.js";
import type { Group } from "./state.js";

export function PaletteList({ grouped, selectedIndex }: { grouped: Group[]; selectedIndex: number }) {
  const theme = useTheme();
  let cursor = 0;
  return (
    <Box flexDirection="column">
      {grouped.map((g, gi) => (
        <Box key={gi} flexDirection="column" marginTop={gi === 0 ? 0 : 1}>
          <Text bold color={theme.primary}>{t(`palette.section.${g.id}`)}</Text>
          {g.items.map(({ item, result }) => {
            const isSel = cursor === selectedIndex;
            cursor += 1;
            return <PaletteRow key={item.id} item={item} selected={isSel} result={result} />;
          })}
        </Box>
      ))}
    </Box>
  );
}
