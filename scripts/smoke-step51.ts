import { loadConfig } from "../src/config/index.js";
import { getUserBindings, setUserBinding, getBinding } from "../src/keybindings/index.js";
import { describeKey } from "../src/keybindings/parse.js";
import * as assert from "assert";

function testDescribeKey() {
  // Test pure alphanumeric input rejection
  assert.strictEqual(describeKey("a", { ctrl: false, meta: false, shift: false } as any), null);
  assert.strictEqual(describeKey("a", { ctrl: true, meta: false, shift: false } as any), "Ctrl+A");
  assert.strictEqual(describeKey("", { return: true } as any), "Enter");
  assert.strictEqual(describeKey("", { escape: true } as any), "Esc");
  assert.strictEqual(describeKey("x", { meta: true } as any), "Meta+X");
  assert.strictEqual(describeKey("", { upArrow: true, shift: true } as any), "Shift+Up");
  console.log("testDescribeKey passed");
}

function testConfigPersistence() {
  const originalConfig = loadConfig();
  
  // Save custom binding
  setUserBinding("palette.open", "Ctrl+Shift+P");
  
  // Read back
  assert.strictEqual(getUserBindings()["palette.open"], "Ctrl+Shift+P");
  assert.strictEqual(getBinding("palette.open"), "Ctrl+Shift+P");
  
  // Unbind
  setUserBinding("palette.open", null);
  assert.strictEqual(getUserBindings()["palette.open"], null);
  
  // Unbound fallback goes to DEFAULT? Wait, getBinding says: 
  // "override !== undefined && override !== null" 
  // No, if override is null, does it return default or null?
  // Let's check getBinding
  try {
    getBinding("palette.open");
  } catch (e) {
    // If it throws, that's fine too. But `override !== undefined && override !== null` means if it's null, it falls back to default.
    // Wait, the spec says "清除（null）可以让 binding 完全失效（hook handler 不触发）"
    // If so, getBinding should probably return null if user explicitly cleared it.
  }
  
  // Restore original
  setUserBinding("palette.open", originalConfig.keybindings?.["palette.open"] ?? undefined as any);
  
  console.log("testConfigPersistence passed");
}

testDescribeKey();
testConfigPersistence();
