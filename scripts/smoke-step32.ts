import { en } from "../src/i18n/locales/en.js";
import { zh } from "../src/i18n/locales/zh.js";
import { flatten } from "../src/i18n/flatten.js";

function runSmokeTest() {
  const flatEn = flatten(en);
  const flatZh = flatten(zh);

  const keysEn = new Set(Object.keys(flatEn));
  const keysZh = new Set(Object.keys(flatZh));

  let failed = false;

  for (const key of keysEn) {
    if (!keysZh.has(key)) {
      console.error(`[smoke-step32] zh missing key: ${key}`);
      failed = true;
    }
  }

  for (const key of keysZh) {
    if (!keysEn.has(key)) {
      console.error(`[smoke-step32] en missing key: ${key}`);
      failed = true;
    }
  }

  const slashRegex = /^\/[a-z][a-z-]+$/;
  for (const [key, value] of Object.entries(flatEn)) {
    if (slashRegex.test(value)) {
      console.error(`[smoke-step32] en dictionary value contains slash command at ${key}: ${value}`);
      failed = true;
    }
  }

  for (const [key, value] of Object.entries(flatZh)) {
    if (slashRegex.test(value)) {
      console.error(`[smoke-step32] zh dictionary value contains slash command at ${key}: ${value}`);
      failed = true;
    }
  }

  if (failed) {
    console.error("[smoke-step32] FAILED");
    process.exit(1);
  }

  console.log("[smoke-step32] PASS: Dictionaries match and contain no raw slash commands");
}

runSmokeTest();
