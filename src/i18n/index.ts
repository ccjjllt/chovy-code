import { loadConfig, saveConfigPatch } from "../config/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { logger } from "../logger/logger.js";
import { flatten, resolveTemplate } from "./flatten.js";
import { detectInitialPreference, detectSystemLocale } from "./detect.js";
import { en } from "./locales/en.js";
import { zh } from "./locales/zh.js";
import type { Locale, LocaleAlias, LocalePreference } from "./locales.js";
import { normalizeLocale, LABEL_KEY } from "./locales.js";

type Params = Record<string, string | number | boolean>;
type Dictionary = Record<string, string>;

const base = flatten(en);
const cache = new Map<Locale, Dictionary>([["en", base]]);
const loaders: Record<Locale, () => Promise<Dictionary>> = {
  en: async () => base,
  zh: async () => ({ ...base, ...flatten(zh) }),
};

let preference: LocalePreference = "zh";
let effective: Locale = "zh";
let dict: Dictionary = { ...base, ...flatten(zh) };
const missingWarned = new Set<string>();

export function getLocalePreference(): LocalePreference {
  return preference;
}

export function getLocale(): Locale {
  return effective;
}

export function labelLocale(loc: Locale | "auto"): string {
  if (loc === "auto") return t("language.auto");
  return t(LABEL_KEY[loc]);
}

export function t(key: string, params?: Params): string {
  const template = dict[key] ?? base[key];
  if (template === undefined) {
    if (!missingWarned.has(key)) {
      missingWarned.add(key);
      logger.warn(`[i18n] missing key: ${key} (locale=${effective})`);
    }
    return `[missing: ${key}]`;
  }
  return resolveTemplate(template, params);
}

export async function setLocale(next: LocalePreference | LocaleAlias | undefined): Promise<void> {
  const nextPref = next === undefined ? detectInitialPreference(loadConfig().i18n?.locale) : 
                   next === "auto" ? "auto" : normalizeLocale(next);
  preference = nextPref;
  effective = preference === "auto" ? detectSystemLocale() : preference;
  
  dict = cache.get(effective) ?? await loaders[effective]();
  cache.set(effective, dict);
  
  // Persist if explicitly set by user and not just initialization
  if (next !== undefined) {
    saveConfigPatch({ i18n: { locale: preference } });
  }

  emitTelemetry({ type: "tui.locale.change", locale: effective, preference });
}
