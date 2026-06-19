import { mountCompanion, _resetStateMachineForTesting } from "../src/companion/index.js";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmoke() {
  console.log("Running smoke-step39.ts...");

  // 1. Mount companion
  const handle = mountCompanion({ cwd: process.cwd(), muted: false });
  console.log("[smoke] mounted companion");

  // 2. Immediate dispose
  handle.dispose();
  console.log("[smoke] disposed companion");

  // Verify node event loop exits successfully without lingering timers
  console.log("[smoke] waiting for 100ms...");
  await sleep(100);
  
  _resetStateMachineForTesting();
  console.log("All step 39 smoke tests passed!");
}

runSmoke().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
