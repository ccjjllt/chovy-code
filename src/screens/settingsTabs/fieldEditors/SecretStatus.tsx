import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../../theme/index.js";
import { t } from "../../../i18n/index.js";
import type { SettingsField } from "../index.js";

export function SecretStatus({
  field,
  onCommit,
  onCancel,
}: {
  field: SettingsField;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [input, setInput] = useState("");

  useInput(
    (char, key) => {
      if (key.return) {
        void field.write(input).then(() => {
          onCommit();
        });
      } else if (key.escape) {
        onCancel();
      } else if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
      } else if (char && !key.ctrl && !key.meta) {
        setInput((prev) => prev + char);
      }
    },
    { isActive: true }
  );

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>{field.label}</Text>
      <Box borderStyle="single" borderColor={theme.accent}>
        <Text>{input.length > 0 ? "*".repeat(input.length) : t("settings.secret.prompt")}</Text>
      </Box>
    </Box>
  );
}
