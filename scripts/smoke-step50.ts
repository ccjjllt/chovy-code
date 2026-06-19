import { getTheme, setTheme, setCustomTheme, resetTheme } from "../src/theme/index.js";
import { getLocalePreference, setLocale, getLocale, labelLocale } from "../src/i18n/index.js";
import { loadConfig } from "../src/config/index.js";
import assert from "node:assert";

async function smoke() {
  console.log("=== step-50 smoke ===");

  // 1. Theme Check
  const initTheme = getTheme();
  console.log("[Theme] init:", initTheme.name);

  setTheme("ChovyLight");
  assert.strictEqual(getTheme().name, "ChovyLight", "setTheme should change active theme");

  // Test setCustomTheme
  setCustomTheme({ primary: "#123456" });
  assert.strictEqual(getTheme().primary, "#123456", "setCustomTheme should override primary color");
  assert.strictEqual(loadConfig().theme?.custom?.primary, "#123456", "setCustomTheme should persist custom config");

  // Reset theme
  resetTheme();
  assert.strictEqual(getTheme().name, "ChovyDefault", "resetTheme should revert to ChovyDefault");
  assert.strictEqual(getTheme().primary, "#7C3AED", "resetTheme should clear custom config");

  // 2. Locale Check
  const initLocale = getLocalePreference();
  console.log("[Locale] init preference:", initLocale, "effective:", getLocale());

  await setLocale("en");
  assert.strictEqual(getLocalePreference(), "en", "setLocale should change preference");
  assert.strictEqual(getLocale(), "en", "effective locale should be 'en'");

  await setLocale("zh");
  assert.strictEqual(getLocalePreference(), "zh", "setLocale should change preference");
  assert.strictEqual(getLocale(), "zh", "effective locale should be 'zh'");

  // 3. labelLocale
  const enLabel = labelLocale("en");
  const zhLabel = labelLocale("zh");
  const autoLabel = labelLocale("auto");
  assert(enLabel.length > 0, "enLabel should not be empty");
  assert(zhLabel.length > 0, "zhLabel should not be empty");
  assert(autoLabel.length > 0, "autoLabel should not be empty");

  console.log("✔ All step-50 smoke tests passed!");
}

smoke().catch(err => {
  console.error("❌ smoke test failed:", err);
  process.exit(1);
});
