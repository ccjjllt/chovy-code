
import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import { t } from "../i18n/index.js";

export function PaletteHeader() {
  const theme = useTheme();
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text bold color={theme.primary}>{t("palette.title")}</Text>
      <Text dimColor>{t("palette.scope.commands")}</Text>
    </Box>
  );
}
