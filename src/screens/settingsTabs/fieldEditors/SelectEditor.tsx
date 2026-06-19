import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../../theme/index.js";
import type { SettingsField } from "../index.js";

export function SelectEditor({
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
  
  const options = typeof field.options === "function" ? field.options() : (field.options ?? []);
  const initialIndex = Math.max(0, options.findIndex(o => o.value === value));
  const [cursor, setCursor] = useState(initialIndex);

  useInput((_input, key) => {
    if (key.return) {
      onChange(options[cursor]?.value ?? value);
      onCommit();
    } else if (key.escape) {
      onCancel();
    } else if (key.upArrow || key.leftArrow) {
      setCursor(c => Math.max(0, c - 1));
      onChange(options[Math.max(0, cursor - 1)]?.value ?? value);
    } else if (key.downArrow || key.rightArrow) {
      setCursor(c => Math.min(options.length - 1, c + 1));
      onChange(options[Math.min(options.length - 1, cursor + 1)]?.value ?? value);
    }
  }, { isActive: true });
  
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>{field.label}</Text>
      <Box flexDirection="row">
        {options.map((opt, i) => (
          <Box key={opt.value} paddingRight={1}>
            <Text color={i === cursor ? theme.accent : undefined} inverse={i === cursor}>
              {` ${opt.label} `}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
