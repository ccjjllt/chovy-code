import { render, Text } from 'ink';
import { Panel } from '../src/tui/kit/Panel.js';
import { Spinner } from '../src/tui/kit/Spinner.js';
import { setTheme } from '../src/theme/index.js';
import { PassThrough } from 'stream';

async function run() {
  console.log("Running smoke test for Component Kit (Step 35)...");

  // Default theme
  setTheme("ChovyDefault");
  const stream1 = new PassThrough();
  let instance = render(
    <Panel title="HelloPanel" borderColor="#7C3AED">
      <Spinner label="Loading..." />
    </Panel>,
    { stdout: stream1 as any, debug: true }
  );

  await new Promise(r => setTimeout(r, 100));
  instance.unmount();

  let frame = stream1.read()?.toString() || '';
  console.log("--- Default Theme Frame ---");
  console.log(frame);
  
  if (!frame.includes("HelloPanel")) throw new Error("Missing title HelloPanel");
  if (!frame.includes("Loading...")) throw new Error("Missing spinner label Loading...");

  // Monochrome theme
  setTheme("ChovyMonochrome");
  const stream2 = new PassThrough();
  instance = render(
    <Panel title="MonoPanel" borderColor="white">
      <Text>Mono</Text>
    </Panel>,
    { stdout: stream2 as any, debug: true }
  );

  await new Promise(r => setTimeout(r, 100));
  instance.unmount();

  frame = stream2.read()?.toString() || '';
  console.log("--- Monochrome Theme Frame ---");
  console.log(frame);
  
  if (!frame.includes("MonoPanel")) throw new Error("Missing title MonoPanel");
  
  console.log("Smoke test passed!");
  process.exit(0);
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
