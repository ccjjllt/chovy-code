export type Locale = "zh" | "en";
export type LocaleAlias = "zh-CN" | "en-US";
export type LocalePreference = Locale | "auto";

export const LOCALES = ["zh", "en"] as const;
export const INTL: Record<Locale, string> = {
  zh: "zh-Hans",
  en: "en",
};
export const LABEL_KEY: Record<Locale, string> = {
  zh: "language.zh",
  en: "language.en",
};

export function normalizeLocale(value: string | undefined): Locale {
  const raw = (value ?? "").toLowerCase();
  if (raw === "zh" || raw === "zh-cn" || raw.startsWith("zh_hans") || raw.startsWith("zh-cn")) return "zh";
  if (raw === "en" || raw === "en-us" || raw.startsWith("en_") || raw.startsWith("en-")) return "en";
  return "zh";
}
