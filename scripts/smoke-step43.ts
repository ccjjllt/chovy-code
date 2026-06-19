import {
  registerCommand,
  listCommands,
  execCommand,
  clearRegistryForTesting,
} from "../src/palette/registry.js";
// 
import { registerAllCommandSources } from "../src/cli/commandSources.js";
import { setLocale } from "../src/i18n/index.js";
import { getGroupedCommands } from "../src/palette/group.js";
import type { ReplCtx } from "../src/cli/slashCommands.js";
import { chovyCacheDir, ensureHomeDirs } from "../src/fs/home.js";
import { join } from "node:path";
import { rmSync } from "node:fs";

async function runSmokeTest() {
  console.log("=== Step 43: Palette Registry Smoke Test ===");

  ensureHomeDirs();
  const mruPath = join(chovyCacheDir(), "palette-mru.json");
  try { rmSync(mruPath); } catch {}

  // Basic Context Mock
  const logs: string[] = [];
  const mockCtx: ReplCtx = {
    appendSystem: (msg) => logs.push(msg),
    setMode: () => {},
    clearMessages: () => {},
    toggleHelp: () => {},
    setGoal: () => {},
    exit: () => {},
    listProviders: () => [],
    listAgents: () => [],
    listSkills: () => [],
  };

  await setLocale("en");
  clearRegistryForTesting();

  // Test 1: MRU & Recommended
  registerCommand({
    id: "test.cmd1",
    label: () => "Cmd1",
    category: "tools",
    run: () => {},
    suggested: true,
  });
  registerCommand({
    id: "test.cmd2",
    label: () => "Cmd2",
    category: "tools",
    run: () => {},
  });

  let grouped = getGroupedCommands(mockCtx, "");
  let recommend = grouped.find(g => g.category === "recommend");
  if (!recommend || recommend.items.length === 0 || recommend.items[0]?.id !== "test.cmd1") {
    throw new Error("Suggested item not at the top of recommendations");
  }

  await execCommand(listCommands(mockCtx).find(c => c.id === "test.cmd2")!, mockCtx);
  
  grouped = getGroupedCommands(mockCtx, "");
  recommend = grouped.find(g => g.category === "recommend");
  // MRU adds it to recommend group
  if (!recommend || !recommend.items.find(c => c.id === "test.cmd2")) {
    throw new Error("MRU bump failed to put command in recommendations");
  }

  // Test 2: Coverage >= 72 cc-haha equivalents
  clearRegistryForTesting();
  await registerAllCommandSources(mockCtx);

  const allCmds = listCommands(mockCtx);
  const byGroup: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const nonCounted: string[] = [];
  let commandEquivalents = 0;

  for (const c of allCmds) {
    // If it's disabled or hidden, it goes to nonCounted
    const enabled = typeof c.enabled === "function" ? c.enabled(mockCtx) : c.enabled !== false;
    const hidden = typeof c.hidden === "function" ? c.hidden(mockCtx) : !!c.hidden;
    
    if (!enabled || hidden) {
      nonCounted.push(`${c.id} (disabled/hidden)`);
      continue;
    }

    commandEquivalents++;
    byGroup[c.category] = (byGroup[c.category] || 0) + 1;
    bySource[c.source || "unknown"] = (bySource[c.source || "unknown"] || 0) + 1;
  }

  console.log(`\nCoverage Results:`);
  console.log(`commandEquivalents: ${commandEquivalents}`);
  console.log(`byGroup:`, byGroup);
  console.log(`bySource:`, bySource);
  console.log(`nonCounted:`, nonCounted.slice(0, 5), `... (${nonCounted.length} total)`);

  if (commandEquivalents < 72) {
    throw new Error(`Coverage requirement failed! Need 72, got ${commandEquivalents}`);
  }

  console.log("\n✅ All Step 43 smoke tests passed!");
}

runSmokeTest().catch(err => {
  console.error("Test Failed:", err);
  process.exit(1);
});
