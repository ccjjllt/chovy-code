import { t, getLocale } from "./index.js";
import { INTL } from "./locales.js";

export interface UiI18nBridge {
  locale: () => string; // getIntlLocale()
  t: typeof t;
}

export function getUiI18nBridge(): UiI18nBridge {
  return {
    locale: () => INTL[getLocale()],
    t,
  };
}
