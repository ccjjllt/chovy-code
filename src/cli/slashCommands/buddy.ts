import type { SlashEntry } from "../slashCommands.js";
import { buddyHandler } from "../../companion/slashBuddy.js";
import { t } from "../../i18n/index.js";

export const buddySlashEntry: SlashEntry = {
  handler: buddyHandler,
  help: t("companion.slash.help") || "Manage the virtual companion",
};
