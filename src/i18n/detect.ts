import type { Locale, LocalePreference } from "./locales.js";
import { normalizeLocale } from "./locales.js";

export function detectInitialPreference(cfgLocale?: string): LocalePreference {
  if (cfgLocale === "auto") return "auto";
  if (cfgLocale === "zh" || cfgLocale === "en" || cfgLocale === "zh-CN" || cfgLocale === "en-US") {
    return normalizeLocale(cfgLocale);
  }
  return "zh"; // 新安装默认中文
}

export function detectSystemLocale(env = process.env): Locale {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return normalizeLocale(raw);
}
