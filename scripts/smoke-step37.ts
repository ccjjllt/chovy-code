import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { safeFs } from "../src/fs/safeFs.js";
import { loadFramesCached } from "../src/companion/cache.js";

// Note: This smoke test runs using bun test directly.
// In actual chovy-code environment, we would use a spawn but here we can just test the logic directly.

describe("Companion Player Step 37", () => {
  it("should decode and cache a GIF frame by frame", async () => {
    // 1. Setup a mock GIF using a simple 1x1 base64 GIF
    const tinyGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const testDir = path.join(os.tmpdir(), "chovy-test-" + Date.now());
    await safeFs.mkdirp(testDir);
    const gifPath = path.join(testDir, "test.gif");
    await Bun.write(gifPath, tinyGif);

    const cols = 20;

    // 2. Load it (will miss cache and decode)
    const t0 = Date.now();
    const result1 = await loadFramesCached(gifPath, cols);
    const timeToDecode = Date.now() - t0;
    expect(timeToDecode).toBeGreaterThanOrEqual(0); // Use the variable to avoid TS6133
    
    expect(result1.frames).toBeDefined();
    expect(result1.frames.length).toBeGreaterThan(0);
    expect(result1.frames[0]?.ansi).toBeDefined();
    
    // 3. Load it again (will hit cache)
    const t1 = Date.now();
    const result2 = await loadFramesCached(gifPath, cols);
    const timeFromCache = Date.now() - t1;

    expect(timeFromCache).toBeLessThan(500); // Should be very fast
    expect(result2.frames.length).toBe(result1.frames.length);
    expect(result2.frames[0]?.ansi).toBe(result1.frames[0]?.ansi);
  });
});
