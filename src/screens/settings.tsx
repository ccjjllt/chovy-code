import React from "react";
import { Box, Text, useInput } from "ink";
import { useSettingsState, closeSettings, setCategory, commitDirty } from "./state.js";
import { useTheme } from "../theme/index.js";
import { useTerminalCaps } from "../tui/capabilities.js";
import { useKeybinding, getBinding } from "../keybindings/index.js";
import { t } from "../i18n/index.js";
import { SplitPane } from "../tui/primitives/SplitPane.js";
import { CATEGORY_LIST } from "./settingsTabs/index.js";
import type { SettingsCategory } from "./state.js";
import type { ReplCtx } from "../cli/slashCommands.js";
import { ChovyError } from "../types/errors.js";

// Import panel placeholders
import { GeneralPanel } from "./settingsTabs/general.js";
import { ProviderPanel } from "./settingsTabs/provider.js";
import { ModelPanel } from "./settingsTabs/model.js";
import { ThemePanel } from "./settingsTabs/theme.js";
import { LanguagePanel } from "./settingsTabs/language.js";
import { KeybindPanel } from "./settingsTabs/keybind.js";
import { AdvancedPanel } from "./settingsTabs/advanced.js";

export async function runFieldOnce(fieldId: string, value: string): Promise<void> {
  const { listSettingsFields } = await import("./settingsTabs/index.js");
  const f = listSettingsFields().find(x => x.id === fieldId);
  if (!f) throw new ChovyError("INTERNAL", `unknown setting: ${fieldId}`);
  const err = f.validate?.(value);
  if (err) throw new ChovyError("CONFIG_INVALID", err);
  await f.write(value);
}

function SettingsHeader({ dirty }: { dirty: number }) {
  const theme = useTheme();
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text bold color={theme.primary}>{t("settings.title")}</Text>
      <Box>
        {dirty > 0 ? <Text color={theme.warning}>{t("settings.dirty", { n: dirty })} · </Text> : null}
        <Text dimColor>{`${getBinding("settings.cancel")} 取消 · ${getBinding("settings.save")} 保存`}</Text>
      </Box>
    </Box>
  );
}

function CategoryList({ category, onPick: _onPick }: { category: SettingsCategory; onPick: (c: SettingsCategory) => void }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingRight={1}>
      {CATEGORY_LIST.map((c) => (
        <Box key={c} paddingY={0}>
          <Text inverse={c === category} bold={c === category} color={c === category ? theme.accent : undefined}>
            {` ${t(`settings.category.${c}`)} `}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function CategoryPanel({ category, highlightFieldId }: { category: SettingsCategory; highlightFieldId?: string }) {
  switch (category) {
    case "general":  return <GeneralPanel highlightFieldId={highlightFieldId} />;
    case "provider": return <ProviderPanel highlightFieldId={highlightFieldId} />;
    case "model":    return <ModelPanel highlightFieldId={highlightFieldId} />;
    case "theme":    return <ThemePanel highlightFieldId={highlightFieldId} />;
    case "language": return <LanguagePanel highlightFieldId={highlightFieldId} />;
    case "keybind":  return <KeybindPanel highlightFieldId={highlightFieldId} />;
    case "advanced": return <AdvancedPanel highlightFieldId={highlightFieldId} />;
  }
}

function SettingsFooter() {
  return null; // For step-57 focus ring hints etc.
}

export function SettingsScreen({ ctx: _ctx }: { ctx: ReplCtx }): React.ReactElement | null {
  const { open, category, dirty, highlightFieldId } = useSettingsState();
  const theme = useTheme();
  const caps = useTerminalCaps();

  useKeybinding("settings.cancel", () => closeSettings({ discard: true }), { isActive: open });
  useKeybinding("settings.save", () => { void commitDirty(); }, { isActive: open });
  
  // Future use in step-57 global focus ring:
  // useKeybinding("focus.next", () => cycleSettingsFocus("forward"), { isActive: open });

  useInput((_input, key) => {
    if (!open) return;
    if (key.upArrow) {
      const idx = CATEGORY_LIST.indexOf(category);
      if (idx > 0) setCategory(CATEGORY_LIST[idx - 1]!);
    } else if (key.downArrow) {
      const idx = CATEGORY_LIST.indexOf(category);
      if (idx < CATEGORY_LIST.length - 1) setCategory(CATEGORY_LIST[idx + 1]!);
    }
  }, { isActive: open });

  if (!open) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.accent}
      paddingX={1}
      width={Math.min(caps.cols - 4, 100)}
      height={Math.min(caps.rows - 4, 32)}
    >
      <SettingsHeader dirty={Object.keys(dirty).length} />
      <SplitPane
        ratio={0.28}
        left={<CategoryList category={category} onPick={setCategory} />}
        right={<CategoryPanel category={category} highlightFieldId={highlightFieldId} />}
      />
      <SettingsFooter />
    </Box>
  );
}
