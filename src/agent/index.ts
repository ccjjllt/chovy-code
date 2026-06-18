/**
 * `src/agent/` barrel.
 *
 * Step-16 introduces `QueryEngine` (in `src/engine/`) and a thin runner
 * wrapper (`runAgent.ts`). The legacy `agent.ts` remains as a back-compat
 * shim that re-exports from `runAgent.ts`. New consumers should import
 * directly from this barrel; sub-agent / swarm / goal callers (step-18+)
 * may also reach into `../engine/` for `QueryEngine` itself.
 */

export { runAgent, runQuery } from "./runAgent.js";
export type { AgentOptions } from "./runAgent.js";
