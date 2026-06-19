import { Box } from "ink";
import { getLocalePreference, setLocale, getLocale, labelLocale, t } from "../../i18n/index.js";
import { loadConfig, saveConfigPatch } from "../../config/index.js";
import type { SettingsField } from "./index.js";
import { registerSettingsField } from "./index.js";
import { FieldList } from "./FieldList.js";
import type { LocalePreference } from "../../i18n/locales.js";

const FIELDS: SettingsField[] = [
  {
    id: "i18n.locale",
    label: "settings.field.locale",
    category: "language",
    type: "select",
    read: () => getLocalePreference(),
    write: async (v) => setLocale(v as LocalePreference),
    options: () => [
      { value: "auto", label: `${t("settings.option.auto")} (${labelLocale(getLocale())})` },
      { value: "zh", label: labelLocale("zh") },
      { value: "en", label: labelLocale("en") },
    ],
  },
  {
    id: "i18n.responseLanguage",
    label: "settings.field.responseLanguage",
    category: "language",
    type: "select",
    read: () => loadConfig().i18n?.responseLanguage ?? "auto",
    write: async (v) => saveConfigPatch({ i18n: { responseLanguage: v } } as any),
    options: () => [
      { value: "auto", label: t("settings.option.auto") },
      { value: "zh", label: labelLocale("zh") },
      { value: "en", label: labelLocale("en") },
    ],
  },
  {
    id: "i18n.costInCNY",
    label: "settings.field.costInCNY",
    category: "language",
    type: "toggle",
    read: () => String(loadConfig().i18n?.costInCNY ?? false),
    write: async (v) => saveConfigPatch({ i18n: { costInCNY: v === "true" } }),
  },
];

for (const f of FIELDS) registerSettingsField(f);

export function LanguagePanel({ highlightFieldId }: { highlightFieldId?: string }) {
  return (
    <Box flexDirection="column">
      <FieldList category="language" highlightFieldId={highlightFieldId} fields={FIELDS} />
    </Box>
  );
}
