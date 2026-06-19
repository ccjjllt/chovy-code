import { incPetCount, getPrefs } from "../src/companion/prefs.js";
import { loadConfig } from "../src/config/index.js";

async function main() {
  const initial = getPrefs().petCount || 0;
  console.log("Initial petCount:", initial);
  
  for (let i = 0; i < 5; i++) {
    incPetCount();
  }
  
  // Reload config to ensure it was saved to disk
  const newConfig = loadConfig();
  const current = newConfig.companion?.petCount || 0;
  console.log("After 5 pets:", current);
  
  if (current !== initial + 5) {
    console.error(`Smoke test failed: expected ${initial + 5}, got ${current}`);
    process.exit(1);
  }
  
  console.log("Smoke test passed!");
}

main().catch(console.error);
