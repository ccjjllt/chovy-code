import { render } from 'ink';
import { WelcomeScreen } from '../src/screens/welcome.js';
import { setTheme } from '../src/theme/index.js';
import { PassThrough } from 'stream';

async function run() {
  console.log("Running smoke test for WelcomeScreen (Step 45)...");

  setTheme("ChovyDefault");
  const stream1 = new PassThrough();
  let instance = render(
    <WelcomeScreen
      provider={"anthropic" as any}
      model="test-model"
      mode="default"
      cwd="/test/path"
      version="1.0.0"
    />,
    { stdout: stream1 as any, debug: true }
  );

  await new Promise(r => setTimeout(r, 100));
  instance.unmount();

  let frame = stream1.read()?.toString() || '';
  console.log("--- Frame ---");
  console.log(frame);
  
  if (!frame.includes("chovy-code v1.0.0")) throw new Error("Missing version string");
  
  console.log("Smoke test passed!");
  process.exit(0);
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
