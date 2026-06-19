import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../theme/index.js";
import { useKeybinding } from "../../keybindings/index.js";
import { setDirty, useSettingsState } from "../state.js";
import type { SettingsField } from "./index.js";
import { t } from "../../i18n/index.js";

import { ToggleEditor } from "./fieldEditors/ToggleEditor.js";
import { SelectEditor } from "./fieldEditors/SelectEditor.js";
import { ColorEditor } from "./fieldEditors/ColorEditor.js";

interface Props {
  category: string;
  fields: SettingsField[];
  highlightFieldId?: string;
}

export function FieldList({ category, fields, highlightFieldId }: Props) {
  const [cursor, setCursor] = useState(0);
  const items = fields.filter(f => f.category === category);

  useInput((_, key) => {
    // If not in editing mode, handle up/down
    if (key.upArrow) {
      if (cursor > 0) setCursor(cursor - 1);
    } else if (key.downArrow) {
      if (cursor < items.length - 1) setCursor(cursor + 1);
    }
  }, { isActive: true });

  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((f, i) => (
        <FieldRow key={f.id} field={f} selected={i === cursor} highlight={f.id === highlightFieldId} />
      ))}
    </Box>
  );
}

function FieldRow({ field, selected, highlight }: { field: SettingsField, selected: boolean, highlight?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.read());
  const { dirty } = useSettingsState();

  // Entering edit mode
  useKeybinding("focus.next", () => {
    if (selected && !editing) {
      // Refresh value from dirty state or read()
      setValue(dirty[field.id] !== undefined ? dirty[field.id]! : field.read());
      setEditing(true);
    }
  }, { isActive: selected && !editing });

  if (editing) {
    return (
      <Editor
        field={field}
        value={value}
        onChange={setValue}
        onCommit={() => {
          setDirty(field.id, value);
          setEditing(false);
        }}
        onCancel={() => {
          setValue(dirty[field.id] !== undefined ? dirty[field.id]! : field.read());
          setEditing(false);
        }}
      />
    );
  }

  const currentValue = dirty[field.id] !== undefined ? dirty[field.id]! : field.read();

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text inverse={selected} bold={highlight}>{t(field.label)}</Text>
      <FieldValue field={field} value={currentValue} />
    </Box>
  );
}

function FieldValue({ field, value }: { field: SettingsField, value: string }) {
  const theme = useTheme();
  
  if (field.type === "toggle") {
    return <Text color={value === "true" ? theme.success : theme.muted}>{value === "true" ? t("settings.option.on") : t("settings.option.off")}</Text>;
  }
  
  if (field.type === "select" || field.type === "readonly") {
    const options = typeof field.options === "function" ? field.options() : (field.options || []);
    const opt = options.find(o => o.value === value);
    return <Text color={theme.fg}>{opt ? opt.label : value}</Text>;
  }

  if (field.type === "color") {
    return (
      <Box>
        <Text color={value}>■ </Text>
        <Text color={theme.fg}>{value}</Text>
      </Box>
    );
  }
  
  return <Text color={theme.fg}>{value}</Text>;
}

function Editor({ field, value, onChange, onCommit, onCancel }: { field: SettingsField, value: string, onChange: (v: string) => void, onCommit: () => void, onCancel: () => void }) {
  if (field.type === "toggle") {
    return <ToggleEditor field={field} value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
  if (field.type === "select") {
    return <SelectEditor field={field} value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
  if (field.type === "color") {
    return <ColorEditor field={field} value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
  
  // Fallback for others
  useKeybinding("settings.cancel", () => onCancel(), { isActive: true });
  return <Text>Not implemented editor for {field.type}</Text>;
}
