import { Box, Text } from "ink";
import { useFocusStore } from "../state/focusStore.js";
import { t } from "../../i18n/index.js";
import { useTheme } from "../../theme/index.js";

export function FocusHint() {
  const { current } = useFocusStore();
  const theme = useTheme();

  if (current === "input") return null;

  return (
    <Box paddingX={1}>
      <Text color={theme.muted}>
        {t("focus.hint", { target: t(`focus.target.${current}`) })}
      </Text>
    </Box>
  );
}
