import type { SlashHandler, SlashEntry } from "../slashCommands.js";
import { t } from "../../i18n/index.js";

export const settingsHandler: SlashHandler = (args, ctx) => {
  const fieldId = args.trim() || undefined;
  if (ctx.openSettings) {
    ctx.openSettings(fieldId);
  } else {
    ctx.appendSystem("Settings UI missing");
  }
};

export const settingsSlashEntry: SlashEntry = {
  help: t("slash.settings.desc") || "Open settings",
  handler: settingsHandler,
  category: "settings",
  aliases: ["set", "configui"],
};
