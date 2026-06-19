import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { describeKey } from "../../../keybindings/parse.js";
import { useTheme } from "../../../theme/index.js";
import { t } from "../../../i18n/index.js";

interface Props {
  onCommit: (captured: string) => void;
  onCancel: () => void;
  onClear: () => void;
}

export function HotkeyEditor({ onCommit, onCancel, onClear }: Props) {
  const theme = useTheme();
  const [captured, setCaptured] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.delete || key.backspace) {
      onClear();
      return;
    }
    if (key.return && captured) {
      onCommit(captured);
      return;
    }

    const desc = describeKey(input, key);
    if (!desc) return;
    setCaptured(desc);
  }, { isActive: true });

  if (captured) {
    return (
      <Box>
        <Text>{`${t("settings.keybind.captured")}: `}</Text>
        <Text bold color={theme.accent}>{captured}</Text>
        <Text dimColor>{`  ${t("settings.keybind.confirm")}`}</Text>
      </Box>
    );
  }

  return <Text color={theme.warning}>{t("settings.keybind.recordHint")}</Text>;
}
