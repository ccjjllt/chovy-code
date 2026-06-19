import { Box, Text, useInput } from "ink";
import { useTheme } from "../../../theme/index.js";
import type { SettingsField } from "../index.js";
import { t } from "../../../i18n/index.js";

export function ToggleEditor({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  field: SettingsField;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();

  useInput((_input, key) => {
    if (key.return) {
      onCommit();
    } else if (key.escape) {
      onCancel();
    } else if (key.leftArrow || key.rightArrow || _input === " ") {
      onChange(value === "true" ? "false" : "true");
    }
  }, { isActive: true });
  
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>{field.label}</Text>
      <Box>
        <Text color={value === "true" ? theme.accent : undefined} inverse={value === "true"}>
          {` ${t("settings.option.on")} `}
        </Text>
        <Text color={value === "false" ? theme.accent : undefined} inverse={value === "false"}>
          {` ${t("settings.option.off")} `}
        </Text>
      </Box>
    </Box>
  );
}
