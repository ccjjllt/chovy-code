import type { SlashEntry } from "../slashCommands.js";
import { setLocale, t, getLocalePreference, getLocale, labelLocale } from "../../i18n/index.js";

export const langSlashEntry: SlashEntry = {
  help: t("slash.lang.desc"),
  handler: async (args, ctx) => {
    const next = args.trim().toLowerCase();
    
    if (!next) {
      const pref = getLocalePreference();
      const eff = getLocale();
      ctx.appendSystem(
        `Language settings:\n` +
        `  Preference: ${labelLocale(pref)} (${pref})\n` +
        `  Effective:  ${labelLocale(eff)} (${eff})\n` +
        `\n` +
        `Usage: /lang zh | en | auto`
      );
      return;
    }
    
    if (next === "zh" || next === "en" || next === "auto") {
      await setLocale(next);
      ctx.appendSystem(`Language updated to: ${labelLocale(next)}`);
    } else {
      ctx.appendSystem(`Invalid language: ${next}. Usage: /lang zh | en | auto`);
    }
  },
};
