import { Box, Text, useInput } from "ink";
import { useTheme } from "../../../theme/index.js";
import { useKeybinding } from "../../../keybindings/index.js";
import { t } from "../../../i18n/index.js";
import type { SettingsField } from "../index.js";

function SimpleInput({ value, onChange, placeholder, maxLength }: { value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number }) {
  const theme = useTheme();

  useInput((input, key) => {
    if (key.return || key.escape || key.upArrow || key.downArrow || key.tab || key.leftArrow || key.rightArrow) {
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (input) {
      const next = value + input;
      if (!maxLength || next.length <= maxLength) {
        onChange(next);
      }
    }
  }, { isActive: true });

  const display = value.length > 0 ? value : (placeholder || "");
  const isPlaceholder = value.length === 0;

  return (
    <Box>
      <Text color={isPlaceholder ? theme.muted : theme.fg}>{display}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

export function ColorEditor({ field, value, onChange, onCommit, onCancel }: { field: SettingsField, value: string, onChange: (v: string) => void, onCommit: () => void, onCancel: () => void }) {
  const theme = useTheme();
  
  // Use field.validate if present, otherwise just check valid hex
  const errorMsg = field.validate ? field.validate(value) : (/^#[0-9a-fA-F]{6}$/i.test(value) || value === "default" ? null : t("settings.validate.hex"));
  const valid = errorMsg === null;

  useKeybinding("settings.save", () => {
    if (valid) onCommit();
  }, { isActive: true });
  
  useKeybinding("settings.cancel", () => onCancel(), { isActive: true });

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>{t(field.label)}</Text>
      <Box flexDirection="row">
        <Text>{`> `}</Text>
        <SimpleInput value={value} onChange={onChange} maxLength={7} />
        <Box marginLeft={2}>
          <Text color={valid ? (value === "default" ? undefined : value) : theme.error}>
            {valid ? `■ ${t("settings.theme.preview")}` : errorMsg}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
