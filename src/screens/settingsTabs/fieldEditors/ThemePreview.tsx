import { Box, Text } from "ink";
import { useTheme } from "../../../theme/index.js";
import { t } from "../../../i18n/index.js";

export function ThemePreview() {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>{t("settings.theme.preview")}</Text>
      <Box>
        <Text color={theme.primary}>■ primary  </Text>
        <Text color={theme.accent}>■ accent  </Text>
        <Text color={theme.success}>■ success  </Text>
        <Text color={theme.error}>■ error</Text>
      </Box>
      <Box borderStyle={theme.borderStyle} borderColor={theme.primary} paddingX={1} marginTop={1}>
        <Text color={theme.fg}>{t("settings.theme.previewText")}</Text>
      </Box>
    </Box>
  );
}
