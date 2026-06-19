import { _store, openPalette, closePalette, setPaletteQuery, movePaletteCursor } from "../src/palette/state.js";

async function run() {
  console.log("smoke-step41: starting...");
  
  // Test 1: Initially closed
  if (_store.getState().open !== false) throw new Error("Should be closed initially");
  
  // Test 2: Open palette
  openPalette();
  if (_store.getState().open !== true) throw new Error("Should be open after openPalette()");
  
  // Test 3: Set query
  setPaletteQuery("test");
  if (_store.getState().rawQuery !== "test") throw new Error("rawQuery should be 'test'");
  await new Promise(r => setTimeout(r, 100));
  if (_store.getState().query !== "test") throw new Error("Query should be 'test'");
  
  // Test 4: Move cursor
  movePaletteCursor(1);
  if (_store.getState().selectedIndex !== 1) throw new Error("Cursor should be at 1");
  movePaletteCursor(-1);
  if (_store.getState().selectedIndex !== 0) throw new Error("Cursor should be at 0");
  
  // Test 5: Close palette
  closePalette();
  if (_store.getState().open !== false) throw new Error("Should be closed after closePalette()");
  
  console.log("smoke-step41: SUCCESS");
}

run().catch(err => {
  console.error("smoke-step41 error:", err);
  process.exit(1);
});
