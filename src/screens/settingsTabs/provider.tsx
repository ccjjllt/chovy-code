import { loadConfig, saveConfigPatch } from "../../config/config.js";
import { registerSettingsField } from "./index.js";
import type { SettingsField } from "./index.js";
import { FieldList } from "./components.js";
import { listProviders } from "../../providers/index.js";
import { hasSecret, writeSecret, providerSource } from "../../config/index.js";
import { t } from "../../i18n/index.js";

const PROVIDER_FIELDS: SettingsField[] = [
  {
    id: "provider.current",
    label: "settings.field.provider",
    category: "provider",
    type: "select",
    read: () => loadConfig().provider ?? "openai",
    write: async (v) => saveConfigPatch({ provider: v as any }),
    options: () => listProviders().map((p) => ({ value: p.info.id, label: p.info.label })),
  },
  {
    id: "provider.apiKey",
    label: "settings.field.apiKey",
    category: "provider",
    type: "secret",
    read: () => (hasSecret(loadConfig().provider) ? "configured" : "missing"),
    write: async (v) => writeSecret(loadConfig().provider, v), // 只写 secrets/<provider>
    validate: (v) => (v.trim().length === 0 ? t("settings.validate.secretEmpty") : null),
  },
  {
    id: "provider.source",
    label: "settings.field.providerSource",
    category: "provider",
    type: "readonly",
    read: () => providerSource(loadConfig().provider), // env / secrets / config / custom
    write: async () => {},
  },
  {
    id: "provider.baseUrl",
    label: "settings.field.providerBaseUrl",
    category: "provider",
    type: "text",
    read: () => loadConfig().providers?.[loadConfig().provider]?.baseUrl ?? "",
    write: async (v) =>
      saveConfigPatch({ providers: { [loadConfig().provider]: { baseUrl: v || undefined } } }),
    validate: (v) => (v === "" || /^https?:\/\//.test(v) ? null : t("settings.validate.url")),
  },
];
for (const f of PROVIDER_FIELDS) registerSettingsField(f);

export function ProviderPanel({ highlightFieldId }: { highlightFieldId?: string }) {
  return <FieldList category="provider" highlightFieldId={highlightFieldId} fields={PROVIDER_FIELDS} />;
}
