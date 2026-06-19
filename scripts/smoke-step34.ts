import { parseKey, matchInkKey } from "../src/keybindings/parse.js";
import { detectConflicts } from "../src/keybindings/conflict.js";
import { DEFAULT_BINDINGS } from "../src/keybindings/index.js";
import assert from "assert";

async function run() {
  console.log("Running smoke-step34.ts...");

  // 1. parseKey
  const k1 = parseKey("Ctrl+Shift+P");
  assert(k1.modifiers.ctrl === true);
  assert(k1.modifiers.shift === true);
  assert(k1.modifiers.meta === false);
  assert(k1.primary === "p");
  assert(k1.chord === undefined);

  const k2 = parseKey("Ctrl+X L");
  assert(k2.modifiers.ctrl === true);
  assert(k2.primary === "x");
  assert(k2.chord === "l");

  try {
    parseKey("Esc L");
    assert(false, "Should throw for Esc head");
  } catch (e: any) {
    assert(e.message.includes("Esc cannot be used as a chord head"));
  }

  // 2. matchInkKey
  matchInkKey(k1, "", { ctrl: true, shift: true, meta: false } as any, null);
  // Wait, currentPrimary will be empty if we don't pass `input` or ink specific keys.
  // We need to pass `input: "p"` or similar to test it.
  const r1_real = matchInkKey(k1, "p", { ctrl: true, shift: true, meta: false } as any, null);
  assert(r1_real.match === true);
  assert(r1_real.chordPending === false);

  const r2 = matchInkKey(k2, "x", { ctrl: true, shift: false, meta: false } as any, null);
  assert(r2.match === false);
  assert(r2.chordPending === true);

  const r3 = matchInkKey(k2, "l", { ctrl: false, shift: false, meta: false } as any, "x");
  assert(r3.match === true);
  assert(r3.chordPending === false);

  // 3. Conflict detection
  const conflicts = detectConflicts(DEFAULT_BINDINGS, {
    "palette.open": "Ctrl+P",
    "settings.open": "Ctrl+P", // intentional conflict
  });

  const conflict = conflicts.find((c) => c.key === "Ctrl+P");
  assert(conflict);
  assert(conflict.ids.includes("palette.open"));
  assert(conflict.ids.includes("settings.open"));
  assert(conflict.scope === "global");

  console.log("smoke-step34 ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
