
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme/index.js";
import { t } from "../i18n/index.js";

function SimpleInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const theme = useTheme();

  useInput((input, key) => {
    // Let other keybindings handle navigation/execution
    if (key.return || key.escape || key.upArrow || key.downArrow || key.tab) {
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (input) {
      onChange(value + input);
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

export function PaletteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const theme = useTheme();
  return (
    <Box marginBottom={1}>
      <Text color={theme.accent}>{">"}</Text>
      <Box marginLeft={1}>
        <SimpleInput value={value} onChange={onChange} placeholder={t("palette.search.placeholder")} />
      </Box>
    </Box>
  );
}
