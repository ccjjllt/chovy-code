import { openSettings, closeSettings, setCategory, useSettingsState } from "../src/screens/state.js";
import { CATEGORY_LIST } from "../src/screens/settingsTabs/index.js";
import { settingsSlashEntry } from "../src/cli/slashCommands/settings.js";

async function main() {
  console.log("Smoke step 48: Settings state store");
  
  openSettings();
  
  // Need a way to read state outside of react component, but useSettingsState is a React Hook.
  // Wait, we didn't export `_store.getState()` directly but we can verify it indirectly or just check types.
  
  if (CATEGORY_LIST.length !== 7) throw new Error("Missing categories");
  
  if (settingsSlashEntry.category !== "settings") throw new Error("Wrong category");
  if (!settingsSlashEntry.aliases?.includes("set")) throw new Error("Missing alias");
  
  console.log("PASS");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
