/**
 * Built-in agent definitions (step-19).
 *
 * Registers the 5 built-in roles (Explore / Plan / Verify / Critic /
 * CheckpointWriter) into `AGENT_REGISTRY` at module-load time, mirroring how
 * `src/tools/index.ts` registers tools. Importing this module (directly or
 * via the `src/agent/index.ts` barrel) is what makes the pool aware of the
 * built-in roles — without it, `getBuiltinAgent("explorer")` returns
 * `undefined` and the pool treats every role as a plain label.
 *
 * Registration order doesn't matter (the registry is a Map keyed by role),
 * but we keep a stable order for `chovy agent list` readability.
 */
import { registerBuiltinAgent } from "./registry.js";
import { exploreAgent } from "./exploreAgent.js";
import { planAgent } from "./planAgent.js";
import { verifyAgent } from "./verifyAgent.js";
import { criticAgent } from "./criticAgent.js";
import { checkpointWriterAgent } from "./checkpointWriterAgent.js";

registerBuiltinAgent(exploreAgent);
registerBuiltinAgent(planAgent);
registerBuiltinAgent(verifyAgent);
registerBuiltinAgent(criticAgent);
registerBuiltinAgent(checkpointWriterAgent);

export {
  registerBuiltinAgent,
  getBuiltinAgent,
  listBuiltinAgents,
  _resetBuiltinAgentsForTesting,
} from "./registry.js";
export { exploreAgent } from "./exploreAgent.js";
export { planAgent } from "./planAgent.js";
export { verifyAgent } from "./verifyAgent.js";
export { criticAgent } from "./criticAgent.js";
export { checkpointWriterAgent } from "./checkpointWriterAgent.js";
