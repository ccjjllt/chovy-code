/**
 * Built-in agent registry (step-19).
 *
 * A plain `Map<AgentRole, BuiltInAgentDefinition>` populated at module-load
 * time by `src/agent/builtin/index.ts` (mirroring how `src/tools/index.ts`
 * registers tools). The pool (`src/agent/pool.ts`) consults this registry on
 * every spawn to apply a role's tool whitelist/blacklist, model/provider
 * preference, `omitMemory`, budget/timeout/maxRounds, and Layer-2 system
 * prompt.
 *
 * The registry itself is process-local and in-memory — there is no on-disk
 * persistence and no IPC. Custom roles (`role: "custom"`) are not registered
 * here; they bypass the registry and rely entirely on caller-supplied
 * `SpawnInput` fields.
 */
import type { AgentRole, BuiltInAgentDefinition } from "../../types/index.js";

const AGENT_REGISTRY = new Map<AgentRole, BuiltInAgentDefinition>();

/**
 * Register a built-in agent definition. Re-registering the same role
 * replaces the prior entry (useful in tests). Throws if a *different*
 * definition is already registered for the same role — that indicates a
 * duplicate role id, which is a programming error.
 */
export function registerBuiltinAgent(def: BuiltInAgentDefinition): void {
  const existing = AGENT_REGISTRY.get(def.role);
  if (existing && existing !== def) {
    throw new Error(
      `registerBuiltinAgent: role "${def.role}" already registered ` +
        `(refusing to overwrite a different definition)`,
    );
  }
  AGENT_REGISTRY.set(def.role, def);
}

/** Look up a built-in role definition. Returns `undefined` for `main` /
 *  `custom` and any unregistered role. */
export function getBuiltinAgent(role: AgentRole): BuiltInAgentDefinition | undefined {
  return AGENT_REGISTRY.get(role);
}

/** All registered built-in role definitions (for `chovy agent list`). */
export function listBuiltinAgents(): BuiltInAgentDefinition[] {
  return Array.from(AGENT_REGISTRY.values());
}

/** Test-only: clear the registry. Production code MUST NOT call this. */
export function _resetBuiltinAgentsForTesting(): void {
  AGENT_REGISTRY.clear();
}
