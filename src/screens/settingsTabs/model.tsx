import { loadConfig, saveConfigPatch } from "../../config/config.js";
import { registerSettingsField } from "./index.js";
import type { SettingsField } from "./index.js";
import { FieldList } from "./components.js";
import { t } from "../../i18n/index.js";
import { getProvider } from "../../providers/index.js";

function defaultModelFor(provider: string): string {
  try {
    return getProvider(provider as any).info.defaultModel;
  } catch {
    return "";
  }
}

function listModelsForCurrentProvider(): string[] {
  // Fallback to default model
  return [defaultModelFor(loadConfig().provider)];
}

function isModelVisible(_provider: string, _model: string): boolean {
  // Stub for now
  return true;
}

function listRecentModels(): string[] {
  // Stub for now
  return [];
}

function listVariantsForCurrentModel(): string[] {
  // Stub for now
  return ["default"];
}

const MODEL_FIELDS: SettingsField[] = [
  {
    id: "model.current",
    label: "settings.field.model",
    category: "model",
    type: "select",
    read: () => loadConfig().model ?? defaultModelFor(loadConfig().provider),
    write: async (v) => saveConfigPatch({ model: v }),
    options: () =>
      listModelsForCurrentProvider()
        .filter((m) => isModelVisible(loadConfig().provider, m))
        .map((m) => ({ value: m, label: m })),
  },
  {
    id: "model.visible",
    label: "settings.field.modelVisibility",
    category: "model",
    type: "select",
    read: () => "open",
    write: async () => {}, // 打开 ModelVisibilityEditor
    options: [{ value: "open", label: t("settings.action.configure") }],
  },
  {
    id: "model.favorite",
    label: "settings.field.favoriteModels",
    category: "model",
    type: "select",
    read: () => "open",
    write: async () => {}, // 打开 FavoriteModelsEditor
    options: [{ value: "open", label: t("settings.action.configure") }],
  },
  {
    id: "model.recent",
    label: "settings.field.recentModels",
    category: "model",
    type: "readonly",
    read: () => listRecentModels().slice(0, 10).join(", ") || t("settings.value.empty"),
    write: async () => {},
  },
  {
    id: "model.variant",
    label: "settings.field.modelVariant",
    category: "model",
    type: "select",
    read: () => loadConfig().modelOptions?.variant ?? "default",
    write: async (v) => saveConfigPatch({ modelOptions: { variant: v } }),
    options: () => listVariantsForCurrentModel().map((v) => ({ value: v, label: v })),
  },
  {
    id: "model.reasoningEffort",
    label: "settings.field.reasoningEffort",
    category: "model",
    type: "select",
    read: () => loadConfig().modelOptions?.reasoningEffort ?? "default",
    write: async (v) => saveConfigPatch({ modelOptions: { reasoningEffort: v as any } }),
    options: [
      { value: "default", label: "default" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
  },
];
for (const f of MODEL_FIELDS) registerSettingsField(f);

export function ModelPanel({ highlightFieldId }: { highlightFieldId?: string }) {
  return <FieldList category="model" highlightFieldId={highlightFieldId} fields={MODEL_FIELDS} />;
}
