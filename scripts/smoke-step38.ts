import { getCompanionStateMachine, _resetStateMachineForTesting } from "../src/companion/index.js";
import assert from "node:assert";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmoke() {
  console.log("Running smoke-step38.ts...");

  // 1. Initial state
  let sm = getCompanionStateMachine();
  assert.strictEqual(sm.current(), "idle", "Initial state should be idle");

  let stateChanges: string[] = [];
  let unsub = sm.onChange((s, prev) => {
    stateChanges.push(`${prev} -> ${s}`);
  });

  // 2. Normal flow: idle -> work -> done -> idle(5s)
  sm.setState("work");
  assert.strictEqual(sm.current(), "work");
  
  sm.setState("done");
  assert.strictEqual(sm.current(), "done");
  
  console.log("Waiting 5.1s for auto-decay to idle...");
  await sleep(5100);
  assert.strictEqual(sm.current(), "idle", "Should auto-decay to idle after 5s");

  assert.deepStrictEqual(stateChanges, [
    "idle -> work",
    "work -> done",
    "done -> idle"
  ]);
  
  unsub();
  _resetStateMachineForTesting();

  // 3. Error path: error -> idle(8s)
  sm = getCompanionStateMachine();
  stateChanges = [];
  unsub = sm.onChange((s, prev) => {
    stateChanges.push(`${prev} -> ${s}`);
  });

  sm.setState("error");
  assert.strictEqual(sm.current(), "error");

  console.log("Waiting 8.1s for error auto-decay to idle...");
  await sleep(8100);
  assert.strictEqual(sm.current(), "idle", "Should auto-decay to idle after 8s");

  assert.deepStrictEqual(stateChanges, [
    "idle -> error",
    "error -> idle"
  ]);

  // 4. Idempotency test
  let calls = 0;
  sm.onChange(() => { calls++; });
  
  sm.setState("work");
  assert.strictEqual(calls, 1);
  sm.setState("work"); // redundant
  sm.setState("work"); // redundant
  assert.strictEqual(calls, 1, "Should not trigger onChange if state is unchanged");
  
  unsub();
  _resetStateMachineForTesting();
  
  console.log("All step 38 smoke tests passed!");
}

runSmoke().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
