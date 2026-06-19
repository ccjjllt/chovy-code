import { registerAllCommandSources } from "../src/cli/commandSources.js";
import { listAllCommands, clearRegistryForTesting } from "../src/palette/registry.js";

async function main() {
  clearRegistryForTesting();

  const dummyCtx: any = {
    setMode: () => {},
    appendSystem: () => {},
    clearMessages: () => {},
    toggleHelp: () => {},
    setGoal: () => {},
    exit: () => {},
    listProviders: () => [],
    listAgents: () => [],
    listSkills: () => [],
    openSettings: () => {},
    openSkillPicker: () => {},
    prefillInput: () => {}
  };

  await registerAllCommandSources(dummyCtx);

  const commands = listAllCommands();

  let commandEquivalents = 0;
  const byGroup: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const nonCounted: string[] = [];

  for (const cmd of commands) {
    // If it's disabled or hidden, it's not counted towards the 72
    const isHidden = typeof cmd.hidden === 'function' ? cmd.hidden(dummyCtx) : !!cmd.hidden;
    const isEnabled = typeof cmd.enabled === 'function' ? cmd.enabled(dummyCtx) : cmd.enabled !== false;
    
    if (isHidden || !isEnabled) {
      nonCounted.push(`${cmd.id} (reason: hidden or disabled)`);
      continue;
    }
    
    commandEquivalents++;
    
    const cat = cmd.category || 'uncategorized';
    byGroup[cat] = (byGroup[cat] || 0) + 1;
    
    const src = cmd.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
  }

  console.log(JSON.stringify({
    commandEquivalents,
    byGroup,
    bySource,
    nonCounted
  }, null, 2));

  if (commandEquivalents < 72) {
    console.error(`ERROR: commandEquivalents = ${commandEquivalents}, expected >= 72`);
    process.exit(1);
  } else {
    console.log(`SUCCESS: commandEquivalents = ${commandEquivalents} >= 72`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
