/**
 * `src/agent/` barrel.
 *
 * Step-16 introduced `QueryEngine` (in `src/engine/`) plus a thin runner
 * wrapper (`runAgent.ts`). Step-18 adds the sub-agent runtime: a
 * `SubAgentPool`, lifecycle helpers, and a parent-context snapshot. Step-19
 * adds the built-in agent registry (Explore/Plan/Verify/Critic/
 * CheckpointWriter). Step-22 adds the in-process swarm bus + output buffers
 * for UI progress.
 *
 * The spawn-fn builder is registered with QueryEngine inside
 * `runAgent.ts` (which every entry point — REPL, CLI, back-compat shim
 * — imports), so any top-level (`role === "main"`) run automatically
 * gets `ctx.spawnSubAgent` wired without a separate import dance.
 *
 * Importing this barrel also triggers built-in role registration (the
 * `./builtin/index.js` side-effect import below). Without that import the
 * pool would treat every role as a plain label and skip tool/model/prompt
 * application.
 */

// Side-effect import: registers the 5 built-in roles into AGENT_REGISTRY.
import "./builtin/index.js";

export { runAgent, runQuery } from "./runAgent.js";
export type { AgentOptions } from "./runAgent.js";

export {
  registerBuiltinAgent,
  getBuiltinAgent,
  listBuiltinAgents,
  _resetBuiltinAgentsForTesting,
  exploreAgent,
  planAgent,
  verifyAgent,
  criticAgent,
  checkpointWriterAgent,
} from "./builtin/index.js";

export {
  getSubAgentPool,
  _resetSubAgentPoolForTesting,
  _mergeAllowlistForTesting,
  _mergeDenylistForTesting,
  MAX_SUB_AGENTS,
  DEFAULT_BUDGET_USD,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TIMEOUT_MS,
  type SubAgentPool,
  type PoolFilter,
  type SpawnOptions,
} from "./pool.js";

export {
  buildParentSnapshot,
  formatSnapshotXml,
  DEFAULT_RECENT_MESSAGE_LIMIT,
  type BuildSnapshotOptions,
} from "./snapshot.js";

export {
  makeHandle,
  makeSubAgentId,
  setStatus,
  setPhase,
  finalize,
  isTerminal,
  addUsage,
  type MakeHandleOptions,
  type MutableSubAgentHandle,
} from "./lifecycle.js";

// step-22: in-process pub/sub bus for sub-agent UI progress + streamed-output
// ring buffer. UI-only channels — never persisted (telemetry stays the pool's
// single source per AGENTS.md §17). step-20's SwarmR will reuse the same bus.
export {
  onSwarmEvent,
  emitSwarmEvent,
  _swarmBusListenerCount,
  _resetSwarmBusForTesting,
  type SwarmEvent,
  type SwarmListener,
} from "./swarmBus.js";

export {
  appendOutput,
  getOutput,
  clearOutput,
  markFinished,
  evictExpired,
  _outputBufferCount,
  _resetOutputBuffersForTesting,
} from "./outputBuffer.js";
