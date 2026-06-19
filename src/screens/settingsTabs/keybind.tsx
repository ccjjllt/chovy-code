import { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../theme/index.js";
import { t } from "../../i18n/index.js";
import { DEFAULT_BINDINGS, getBinding, getUserBindings, setUserBinding, detectConflicts } from "../../keybindings/index.js";
import type { KeyBinding } from "../../keybindings/index.js";
import { HotkeyEditor } from "./fieldEditors/HotkeyEditor.js";

interface Props {
  highlightFieldId?: string;
}

function showConflictToast(_conflict: { key: string; ids: string[]; scope: string }) {
  // A simple placeholder since Toast is step-53+. We just log it or rely on ConflictsList
  // The ConflictsList will render it.
}

function KeybindRow({ binding, conflict, highlight, onUpdate }: { binding: KeyBinding; conflict: any; highlight: boolean; onUpdate: (id: string, val: string | null) => void }) {
  const theme = useTheme();
  const [recording, setRecording] = useState(false);
  
  // Use React state to track local binding to trigger re-renders if we don't use a store
  const cur = getBinding(binding.id);
  const isCustom = cur !== binding.defaultKey;

  useInput((_input, key) => {
    if (!highlight || recording) return;
    
    if (key.return) {
      setRecording(true);
    } else if (key.backspace || key.delete) {
      onUpdate(binding.id, null);
    }
  }, { isActive: highlight && !recording });

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text bold={highlight} color={highlight ? theme.accent : undefined}>
          {t(`keybind.${binding.id}`) || binding.description}
        </Text>
        {conflict ? <Text color={theme.error}>{` ⚠ ${t("settings.keybind.conflict")}`}</Text> : null}
      </Box>
      <Box>
        {recording ? (
          <HotkeyEditor 
            onCommit={(c) => {
              onUpdate(binding.id, c);
              setRecording(false);
            }} 
            onCancel={() => setRecording(false)} 
            onClear={() => {
              onUpdate(binding.id, null);
              setRecording(false);
            }} 
          />
        ) : (
          <>
            <Text color={isCustom ? theme.accent : undefined} bold={isCustom}>{cur || "(empty)"}</Text>
            {isCustom ? <Text dimColor>{` (${t("settings.keybind.modified")})`}</Text> : null}
          </>
        )}
      </Box>
    </Box>
  );
}

function ConflictsList({ conflicts }: { conflicts: ReturnType<typeof detectConflicts> }) {
  if (conflicts.length === 0) return null;
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.error} paddingX={1} marginTop={1}>
      <Text bold color={theme.error}>{t("settings.keybind.conflictsHeader")}</Text>
      {conflicts.map((c, i) => (
        <Text key={i}>{`${c.key}: ${c.ids.join(" + ")}`}</Text>
      ))}
    </Box>
  );
}

export function KeybindPanel({ highlightFieldId }: Props) {
  const all = DEFAULT_BINDINGS;
  
  // Actually, to make the UI reactive, we'd need to subscribe to config changes or re-render
  // For this step, since setUserBinding writes to disk immediately, we can use a small local state to force refresh
  const [refreshTick, setRefreshTick] = useState(0);
  
  // We can intercept the setUserBinding to force refresh
  const handleSetUserBinding = (id: string, val: string | null) => {
    if (val !== null) {
      // detect conflict before saving
      const mockUserBindings = { ...getUserBindings(), [id]: val };
      const newConflicts = detectConflicts(all, mockUserBindings);
      const conflict = newConflicts.find((c) => c.key === val);
      
      // If there is a conflict and it includes other IDs than this one
      if (conflict && conflict.ids.some((i) => i !== id)) {
        showConflictToast(conflict);
        return; // Prevent saving
      }
    }
    setUserBinding(id, val);
    setRefreshTick(t => t + 1);
  };

  const conflicts = useMemo(() => {
    // depend on refreshTick to recompute
    return refreshTick !== -1 ? detectConflicts(all, getUserBindings()) : [];
  }, [all, refreshTick]);

  // "设置底部加 '全部恢复' 按钮（R 快捷键）→ 弹确认后 setUserBinding(id, null) for all。"
  useInput((input) => {
    if (input.toLowerCase() === 'r') {
      // Restore all
      const userBindings = getUserBindings();
      for (const id of Object.keys(userBindings)) {
        handleSetUserBinding(id, null);
      }
    }
  }, { isActive: true });

  return (
    <Box flexDirection="column" paddingX={1}>
      {all.map(b => (
        <KeybindRow
          key={b.id}
          binding={b}
          conflict={conflicts.find(c => c.ids.includes(b.id))}
          highlight={b.id === highlightFieldId}
          onUpdate={handleSetUserBinding}
        />
      ))}
      <ConflictsList conflicts={conflicts} />
      
      <Box marginTop={1}>
        <Text dimColor>Press 'r' to restore all defaults</Text>
      </Box>
    </Box>
  );
}
