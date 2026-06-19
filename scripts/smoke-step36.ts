import { decodeGif } from "../src/companion/decoder";
import { frameToAnsi } from "../src/companion/ansi";

async function run() {
  const gifPath = "gif/2026-06-12_012827.GIF";
  console.log(`Decoding ${gifPath}...`);
  
  const startTime = Date.now();
  const meta = await decodeGif(gifPath, 20, {});
  const elapsed = Date.now() - startTime;
  
  console.log(`Decoded in ${elapsed}ms`);
  console.log(`Frames: ${meta.frames.length}`);
  console.log(`Loop Count: ${meta.loopCount}`);
  if (meta.bgColor) {
    console.log(`BgColor: ${meta.bgColor}`);
  }
  
  if (meta.frames.length > 0) {
    const f1 = meta.frames[0];
    if (!f1) { console.error("No frames"); process.exit(1); }
    console.log(`Frame 0 dimensions: ${f1.width}x${f1.height}, data length: ${f1.data.length} (expected: ${f1.width * f1.height * 4})`);
    
    if (f1.data.length !== f1.width * f1.height * 4) {
      console.error("Frame data length mismatch!");
      process.exit(1);
    }
    
    console.log("\nRendering Frame 0:");
    const ansi = frameToAnsi(f1, { alphaThreshold: 128, trueColor: true });
    console.log(ansi);

    if (ansi.includes("\x1b[38;2;")) {
      console.log("Success: true color ANSI found.");
    } else {
      console.error("Error: true color ANSI not found.");
      process.exit(1);
    }
  } else {
    console.error("Error: No frames decoded.");
    process.exit(1);
  }

  console.log("Testing abort...");
  const ac = new AbortController();
  ac.abort();
  try {
    await decodeGif(gifPath, 20, { abortSignal: ac.signal });
    console.error("Error: Did not abort.");
    process.exit(1);
  } catch (e: any) {
    if (e.message === "aborted") {
      console.log("Abort test passed.");
    } else {
      console.error("Abort test failed with wrong error:", e);
      process.exit(1);
    }
  }
  
  console.log("All smoke tests passed.");
}

run().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
