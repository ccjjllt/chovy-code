import { loadConfig, saveConfigPatch } from "../../config/config.js";
import { registerSettingsField } from "./index.js";
import type { SettingsField } from "./index.js";
import { FieldList } from "./components.js";
import { t } from "../../i18n/index.js";

const FIELDS: SettingsField[] = [
  {
    id: "general.releaseNotes",
    label: "settings.field.releaseNotes",
    category: "general",
    section: "updates",
    type: "toggle",
    read: () => String(loadConfig().general?.releaseNotes ?? true),
    write: async (v) => saveConfigPatch({ general: { releaseNotes: v === "true" } }),
  },
  {
    id: "general.showTips",
    label: "settings.field.showTips",
    category: "general",
    section: "onboarding",
    type: "toggle",
    read: () => String(loadConfig().general?.showTips ?? true),
    write: async (v) => saveConfigPatch({ general: { showTips: v === "true" } }),
  },
  {
    id: "general.showReasoningSummaries",
    label: "settings.field.showReasoningSummaries",
    category: "general",
    section: "messages",
    type: "toggle",
    read: () => String(loadConfig().general?.showReasoningSummaries ?? true),
    write: async (v) => saveConfigPatch({ general: { showReasoningSummaries: v === "true" } }),
  },
  {
    id: "general.shellToolPartsExpanded",
    label: "settings.field.shellToolPartsExpanded",
    category: "general",
    section: "messages",
    type: "toggle",
    read: () => String(loadConfig().general?.shellToolPartsExpanded ?? false),
    write: async (v) => saveConfigPatch({ general: { shellToolPartsExpanded: v === "true" } }),
  },
  {
    id: "general.editToolPartsExpanded",
    label: "settings.field.editToolPartsExpanded",
    category: "general",
    section: "messages",
    type: "toggle",
    read: () => String(loadConfig().general?.editToolPartsExpanded ?? false),
    write: async (v) => saveConfigPatch({ general: { editToolPartsExpanded: v === "true" } }),
  },
  {
    id: "general.permissionMode",
    label: "settings.field.permissionMode",
    category: "general",
    section: "behavior",
    type: "select",
    read: () => loadConfig().permissions?.mode ?? "default",
    write: async (v: string) => saveConfigPatch({ permissions: { mode: v as any } }),
    options: [
      { value: "default", label: "default" },
      { value: "ask", label: "ask" },
      { value: "accept-edits", label: "accept-edits" },
    ],
  },
  {
    id: "general.neverAskQuestions",
    label: "settings.field.neverAskQuestions",
    category: "general",
    section: "behavior",
    type: "toggle",
    read: () => String(loadConfig().general?.neverAskQuestions ?? false),
    write: async (v) => saveConfigPatch({ general: { neverAskQuestions: v === "true" } }),
  },
  {
    id: "general.terminalTitle",
    label: "settings.field.terminalTitle",
    category: "general",
    section: "terminal",
    type: "toggle",
    read: () => String(loadConfig().tui?.terminalTitle ?? true),
    write: async (v) => saveConfigPatch({ tui: { terminalTitle: v === "true" } }),
  },
  {
    id: "general.diffWrapMode",
    label: "settings.field.diffWrapMode",
    category: "general",
    section: "messages",
    type: "select",
    read: () => loadConfig().tui?.diffWrapMode ?? "word",
    write: async (v: string) => saveConfigPatch({ tui: { diffWrapMode: v as any } }),
    options: [
      { value: "word", label: t("settings.option.wordWrap") },
      { value: "none", label: t("settings.option.noWrap") },
    ],
  },
  {
    id: "general.toastLevel",
    label: "settings.field.toastLevel",
    category: "general",
    section: "notifications",
    type: "select",
    read: () => loadConfig().tui?.toastLevel ?? "normal",
    write: async (v: string) => saveConfigPatch({ tui: { toastLevel: v as any } }),
    options: [
      { value: "quiet", label: t("settings.option.quiet") },
      { value: "normal", label: t("settings.option.normal") },
      { value: "verbose", label: t("settings.option.verbose") },
    ],
  },
];
for (const f of FIELDS) registerSettingsField(f);

export function GeneralPanel({ highlightFieldId }: { highlightFieldId?: string }) {
  return <FieldList category="general" highlightFieldId={highlightFieldId} fields={FIELDS} />;
}
