import { loadOnboarding, recordEvent } from "../src/screens/onboarding.js";
import { chovyCacheDir, ensureHomeDirs } from "../src/fs/home.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";

// 1. Setup
ensureHomeDirs();
const file = path.join(chovyCacheDir(), "onboarding.json");
if (fs.existsSync(file)) {
  fs.unlinkSync(file);
}

// 2. Initial state
const initial = loadOnboarding();
assert.strictEqual(initial.v, 1);
assert.strictEqual(initial.paletteOpenedCount, 0);
assert.strictEqual(initial.firstActionAt, undefined);

// 3. Trigger events
recordEvent("palette", "0.1.0");
recordEvent("firstAction", "0.1.0");

// 4. Verify disk state
const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
assert.strictEqual(onDisk.paletteOpenedCount, 1);
assert.ok(onDisk.firstActionAt > 0);
assert.strictEqual(onDisk.lastSeenVersion, "0.1.0");

console.log("smoke-step47 passed ✅");
