import { render } from 'ink';
import React from 'react';
import { HeaderBar } from '../src/cli/components/HeaderBar.js';
import { setTheme } from '../src/theme/index.js';
import { TerminalCapsContext } from '../src/tui/capabilities.js';
import { PassThrough } from 'stream';

async function run() {
  console.log("Running smoke test for HeaderBar (Step 46)...");

  setTheme("ChovyDefault");

  const baseProps = {
    mode: "default" as const,
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    budget: { costUSD: 1.23, ctxUsedTokens: 100, ctxTotalTokens: 200, pressureLevel: "soft" as const },
    swarm: { running: 2, done: 1 },
    goal: { rounds: 5, status: "active" as const, budgetUsed: 0.5, budgetCap: 10 },
  };

  const capsWide = { cols: 200, rows: 24, trueColor: true, unicode: true, isConHost: false, isWindowsTerminal: true, isFullScreenCapable: true };
  const capsNarrow = { cols: 50, rows: 24, trueColor: true, unicode: true, isConHost: false, isWindowsTerminal: true, isFullScreenCapable: true };

  let stream = new PassThrough();
  let instance = render(
    <TerminalCapsContext.Provider value={capsWide}>
      <HeaderBar {...baseProps} />
    </TerminalCapsContext.Provider>,
    { stdout: stream as any, debug: true }
  );
  await new Promise(r => setTimeout(r, 100));
  instance.unmount();
  
  let frame = stream.read()?.toString() || '';
  console.log("--- Wide Frame (All chips should be present) ---");
  console.log(frame);
  
  if (!frame.includes("swarm") || !frame.includes("anthropic")) {
    throw new Error("Missing chips in wide terminal");
  }

  stream = new PassThrough();
  instance = render(
    <TerminalCapsContext.Provider value={capsNarrow}>
      <HeaderBar {...baseProps} />
    </TerminalCapsContext.Provider>,
    { stdout: stream as any, debug: true }
  );
  await new Promise(r => setTimeout(r, 100));
  instance.unmount();
  
  frame = stream.read()?.toString() || '';
  console.log("--- Narrow Frame (Only mode and maybe model should be present) ---");
  console.log(frame);
  
  if (frame.includes("swarm")) {
    throw new Error("Swarm chip should be hidden in narrow terminal");
  }

  console.log("Smoke test passed!");
  process.exit(0);
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
