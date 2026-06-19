import { Box } from "ink";
import { getTheme, setTheme, listThemes, setCustomTheme } from "../../theme/index.js";
import { loadConfig, saveConfigPatch } from "../../config/index.js";
import { t } from "../../i18n/index.js";
import type { SettingsField } from "./index.js";
import { registerSettingsField } from "./index.js";
import { FieldList } from "./FieldList.js";
import { ThemePreview } from "./fieldEditors/ThemePreview.js";

const FIELDS: SettingsField[] = [
  {
    id: "theme.name",
    label: "settings.field.theme",
    category: "theme",
    type: "select",
    read: () => getTheme().name,
    write: async (v) => { setTheme(v); },
    options: () => listThemes().map(t => ({ value: t.name, label: t.name })),
  },
  {
    id: "theme.primary",
    label: "settings.field.theme.primary",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.primary ?? getTheme().primary,
    write: async (v) => setCustomTheme({ primary: v }),
    validate: (v) => /^#[0-9a-fA-F]{6}$/i.test(v) ? null : t("settings.validate.hex"),
  },
  {
    id: "theme.accent",
    label: "settings.field.theme.accent",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.accent ?? getTheme().accent,
    write: async (v) => setCustomTheme({ accent: v }),
    validate: (v) => /^#[0-9a-fA-F]{6}$/i.test(v) ? null : t("settings.validate.hex"),
  },
  {
    id: "theme.bg",
    label: "settings.field.theme.bg",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.bg ?? getTheme().bg,
    write: async (v) => setCustomTheme({ bg: v }),
    validate: (v) => v === "default" || /^#[0-9a-fA-F]{6}$/i.test(v) ? null : t("settings.validate.hexOrDefault"),
  },
  {
    id: "theme.fg",
    label: "settings.field.theme.fg",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.fg ?? getTheme().fg,
    write: async (v) => setCustomTheme({ fg: v }),
    validate: (v) => /^#[0-9a-fA-F]{6}$/i.test(v) ? null : t("settings.validate.hex"),
  },
  {
    id: "theme.borderStyle",
    label: "settings.field.theme.border",
    category: "theme",
    type: "select",
    read: () => loadConfig().theme?.custom?.borderStyle ?? getTheme().borderStyle,
    write: async (v) => setCustomTheme({ borderStyle: v }),
    options: () => [
      { value: "round",  label: "round (默认)" },
      { value: "single", label: "single" },
      { value: "double", label: "double" },
      { value: "bold",   label: "bold" },
    ],
  },
  {
    id: "tui.density",
    label: "settings.field.density",
    category: "theme",
    section: "appearance",
    type: "select",
    read: () => loadConfig().tui?.density ?? "comfortable",
    write: async (v) => saveConfigPatch({ tui: { density: v } } as any),
    options: [
      { value: "compact", label: t("settings.option.compact") },
      { value: "comfortable", label: t("settings.option.comfortable") },
    ],
  },
  {
    id: "tui.animations",
    label: "settings.field.animations",
    category: "theme",
    section: "appearance",
    type: "toggle",
    read: () => String(loadConfig().tui?.animations ?? true),
    write: async (v) => saveConfigPatch({ tui: { animations: v === "true" } } as any),
  },
  {
    id: "companion.visible",
    label: "settings.field.companionVisible",
    category: "theme",
    section: "companion",
    type: "toggle",
    read: () => String(loadConfig().companion?.visible ?? true),
    write: async (v) => saveConfigPatch({ companion: { visible: v === "true" } }),
  },
  {
    id: "companion.size",
    label: "settings.field.companionSize",
    category: "theme",
    section: "companion",
    type: "select",
    read: () => loadConfig().companion?.size ?? "auto",
    write: async (v) => saveConfigPatch({ companion: { size: v as any } }),
    options: [
      { value: "auto", label: "auto" },
      { value: "compact", label: "compact" },
      { value: "small", label: "small" },
    ],
  },
];

for (const f of FIELDS) registerSettingsField(f);

export function ThemePanel({ highlightFieldId }: { highlightFieldId?: string }) {
  return (
    <Box flexDirection="column">
      <FieldList category="theme" highlightFieldId={highlightFieldId} fields={FIELDS} />
      <Box marginTop={1} borderStyle="single">
        <ThemePreview />
      </Box>
    </Box>
  );
}
