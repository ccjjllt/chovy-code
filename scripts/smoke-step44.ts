import { registerAllCommandSources } from "../src/cli/commandSources.js";
import { listAllCommands, clearRegistryForTesting } from "../src/palette/registry.js";
import { listSkills, ensureBundledSkillsInitialized } from "../src/skills/registry.js";

export async function getCommandCoverage() {
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

  // Ensure CSG graph counts
  await ensureBundledSkillsInitialized();
  const bundledSkills = listSkills().length;
  
  return {
    commandEquivalents,
    byGroup,
    bySource,
    nonCounted,
    bundledSkills,
    sources: Object.keys(bySource)
  };
}

export async function run() {
  const coverage = await getCommandCoverage();
  if (coverage.commandEquivalents < 72) {
    throw new Error(`ERROR: commandEquivalents = ${coverage.commandEquivalents}, expected >= 72`);
  }
}
