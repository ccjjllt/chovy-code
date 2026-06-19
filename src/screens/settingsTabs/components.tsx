import { useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../theme/index.js";
import { useKeybinding } from "../../keybindings/index.js";
import { t } from "../../i18n/index.js";
import { setDirty } from "../state.js";
import type { SettingsCategory } from "../state.js";
import type { SettingsField } from "./index.js";
import { TextEditor } from "./fieldEditors/TextEditor.js";
import { ToggleEditor } from "./fieldEditors/ToggleEditor.js";
import { SelectEditor } from "./fieldEditors/SelectEditor.js";
import { SecretStatus } from "./fieldEditors/SecretStatus.js";

function FieldValue({ field, value }: { field: SettingsField; value: string }) {
  const theme = useTheme();

  if (field.type === "secret") {
    return value === "configured" ? (
      <Text color={theme.success}>● {t("settings.secret.configured")}</Text>
    ) : (
      <Text color={theme.error}>○ {t("settings.secret.missing")}</Text>
    );
  }

  if (field.type === "toggle") {
    return <Text>{value === "true" ? t("settings.option.on") : t("settings.option.off")}</Text>;
  }

  if (field.type === "select") {
    const options = typeof field.options === "function" ? field.options() : (field.options ?? []);
    const opt = options.find((o) => o.value === value);
    return <Text>{opt ? opt.label : value}</Text>;
  }

  return <Text>{value}</Text>;
}

function Editor({
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
  if (field.type === "secret") {
    return <SecretStatus field={field} onCommit={onCommit} onCancel={onCancel} />;
  }
  if (field.type === "toggle") {
    return <ToggleEditor field={field} value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
  if (field.type === "select") {
    return <SelectEditor field={field} value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  }
  return <TextEditor field={field} value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
}

export function FieldRow({
  field,
  selected,
  highlight,
}: {
  field: SettingsField;
  selected: boolean;
  highlight: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.read());

  useKeybinding(
    "focus.next",
    () => {
      if (selected && !editing && field.type !== "readonly") {
        setEditing(true);
      }
    },
    { isActive: selected && !editing }
  );

  if (editing) {
    return (
      <Editor
        field={field}
        value={value}
        onChange={setValue}
        onCommit={() => {
          if (field.type !== "secret") {
            setDirty(field.id, value);
          }
          setEditing(false);
        }}
        onCancel={() => {
          setValue(field.read());
          setEditing(false);
        }}
      />
    );
  }

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text inverse={selected} bold={highlight}>
        {field.label}
      </Text>
      <FieldValue field={field} value={value} />
    </Box>
  );
}

export function FieldList({
  fields,
  highlightFieldId,
}: {
  category: SettingsCategory;
  fields: SettingsField[];
  highlightFieldId?: string;
}) {
  const [cursor, setCursor] = useState(0);

  useKeybinding(
    "list.up",
    () => {
      setCursor((c) => Math.max(0, c - 1));
    },
    { isActive: fields.length > 0 }
  );

  useKeybinding(
    "list.down",
    () => {
      setCursor((c) => Math.min(fields.length - 1, c + 1));
    },
    { isActive: fields.length > 0 }
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      {fields.map((f, i) => (
        <FieldRow key={f.id} field={f} selected={i === cursor} highlight={f.id === highlightFieldId} />
      ))}
    </Box>
  );
}
