/**
 * Back-compat shim (step-16).
 *
 * The legacy `agent.ts` carried the entire one-shot loop. Step-16 moves
 * that logic into `QueryEngine` (`src/engine/queryEngine.ts`) and exposes
 * a friendlier wrapper at `src/agent/runAgent.ts`. This file now exists
 * solely to preserve the original import path:
 *
 *   import { runAgent } from "../agent/agent.js";
 *
 * Re-exporting from `runAgent.ts` keeps existing CLI / REPL code building
 * unchanged while the new engine takes over the actual work. New code
 * should import from `../agent/index.js` (or the engine barrel) instead.
 */

export { runAgent, runQuery } from "./runAgent.js";
export type { AgentOptions } from "./runAgent.js";
