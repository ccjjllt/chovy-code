/**
 * Sub-agent pool (step-18).
 *
 * Single in-process registry of running sub-agents. Tracks lifecycle
 * handles, enforces the 100-handle hard cap (mirroring `architecture.md`
 * §6 / `docs/step-18 §池与上限`), and is the single source of
 * `subagent.spawn` / `subagent.end` telemetry (per AGENTS.md §17 single-
 * source rule, mirroring `agent.cost` only landing in costTracker and
 * `tool.call` only in the agent loop).
 *
 * Spawn pipeline (background = false):
 *   1. cap check  → ChovyError("AGENT_BUDGET_EXCEEDED") if over
 *   2. mint id, build handle (status = queued), register in map
 *   3. emit subagent.spawn telemetry
 *   4. wire child AbortController + cascade from parentSignal
 *   5. install timeoutMs watchdog (default 120s)
 *   6. run QueryEngine with the child's signal + budget
 *   7. finalize handle (done/failed/cancelled) + emit subagent.end
 *   8. return handle to caller
 *
 * Background pipeline (background = true):
 *   - 1–6 schedule, but pool.spawn resolves with the queued handle as
 *     soon as the child AbortController is wired. Step 7 still emits
 *     subagent.end when the child eventually settles.
 *
 * No external state: there is no on-disk persistence and no IPC. The
 * full pool is wiped on process exit. Step-26's checkpoint-writer agent
 * persists results separately; the pool here is purely live state.
 */
import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { ChovyError } from "../types/errors.js";
import { QueryEngine } from "../engine/queryEngine.js";
import { buildParentSnapshot, formatSnapshotXml } from "./snapshot.js";
import { appendOutput, clearOutput, evictExpired, markFinished } from "./outputBuffer.js";
import { getBuiltinAgent } from "./builtin/index.js";
import {
  finalize,
  isTerminal,
  makeHandle,
  makeSubAgentId,
  setPhase,
  setStatus,
  addUsage,
  type MutableSubAgentHandle,
} from "./lifecycle.js";
import type {
  AgentLifecycle,
  AgentRole,
  BuiltInAgentDefinition,
  ChatMessage,
  ParentRuntimeCtx,
  ProviderId,
  SpawnInput,
  SubAgentHandle,
  SubAgentResult,
} from "../types/index.js";
import type { BuildOptions, SystemContext } from "../prompts/index.js";

/** Hard cap mandated by step-18 §池与上限. Concurrent **active** handles only. */
export const MAX_SUB_AGENTS = 100;

/** Default sub-agent quotas (step-18 §配额与熔断). */
export const DEFAULT_MAX_ROUNDS = 12;
export const DEFAULT_BUDGET_USD = 0.20;
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface SpawnOptions {
  /** Parent runtime context (factory in `runAgent.ts` injects this). */
  parentCtx: ParentRuntimeCtx;
}

export interface PoolFilter {
  parentId?: string;
  status?: AgentLifecycle;
  role?: AgentRole;
  background?: boolean;
}

export interface SubAgentPool {
  spawn(input: SpawnInput, opts: SpawnOptions): Promise<SubAgentHandle>;
  list(filter?: PoolFilter): SubAgentHandle[];
  get(id: string): SubAgentHandle | undefined;
  cancel(id: string): Promise<void>;
  cancelAll(predicate?: (h: SubAgentHandle) => boolean): Promise<void>;
  /** Active count (anything not in a terminal state). */
  activeCount(): number;
  /** Test-only: drop every handle and reset internal state. */
  reset(): void;
}

interface PoolEntry {
  handle: MutableSubAgentHandle;
  ac: AbortController;
  cascadeOff?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
}

class InMemoryPool implements SubAgentPool {
  private map = new Map<string, PoolEntry>();

  activeCount(): number {
    let n = 0;
    for (const e of this.map.values()) if (!isTerminal(e.handle)) n++;
    return n;
  }

  list(filter?: PoolFilter): SubAgentHandle[] {
    const out: SubAgentHandle[] = [];
    for (const e of this.map.values()) {
      if (filter?.parentId && e.handle.parentId !== filter.parentId) continue;
      if (filter?.status && e.handle.status !== filter.status) continue;
      if (filter?.role && e.handle.role !== filter.role) continue;
      if (filter?.background !== undefined && e.handle.background !== filter.background) continue;
      out.push(e.handle);
    }
    return out;
  }

  get(id: string): SubAgentHandle | undefined {
    return this.map.get(id)?.handle;
  }

  async cancel(id: string): Promise<void> {
    const e = this.map.get(id);
    if (!e) return;
    await e.handle.cancel();
  }

  async cancelAll(predicate?: (h: SubAgentHandle) => boolean): Promise<void> {
    const targets: PoolEntry[] = [];
    for (const e of this.map.values()) {
      if (isTerminal(e.handle)) continue;
      if (predicate && !predicate(e.handle)) continue;
      targets.push(e);
    }
    await Promise.all(targets.map((e) => e.handle.cancel()));
  }

  reset(): void {
    for (const e of this.map.values()) {
      e.cascadeOff?.();
      if (e.timer) clearTimeout(e.timer);
      // step-22: clear streamed-output buffers so a reset pool doesn't leak.
      clearOutput(e.handle.id);
    }
    this.map.clear();
  }

  async spawn(input: SpawnInput, opts: SpawnOptions): Promise<SubAgentHandle> {
    if (this.activeCount() >= MAX_SUB_AGENTS) {
      throw new ChovyError(
        "AGENT_BUDGET_EXCEEDED",
        `sub-agent pool full (${MAX_SUB_AGENTS} active)`,
        undefined,
        { active: this.activeCount(), cap: MAX_SUB_AGENTS },
      );
    }

    const role: AgentRole = input.role ?? "main";
    const background = input.background ?? false;
    // step-19: look up the built-in role definition once; the same def feeds
    // both the timeout watchdog (here, in spawn) and the runChild config
    // merge. `main` / `custom` and any unregistered role return undefined,
    // preserving step-18 behavior.
    const roleDef = getBuiltinAgent(role);
    const provider: ProviderId = input.provider ?? roleDef?.preferredProvider ?? opts.parentCtx.parentProvider;
    const model: string | undefined = input.model ?? roleDef?.preferredModel ?? opts.parentCtx.parentModel;
    const id = makeSubAgentId();
    const parentCtx = opts.parentCtx;

    // Child AbortController — never shared with parent (AGENTS.md §9).
    const ac = new AbortController();
    let cascadeOff: (() => void) | undefined;
    if (parentCtx.parentSignal) {
      const signal = parentCtx.parentSignal;
      if (signal.aborted) {
        ac.abort();
      } else {
        const onParentAbort = (): void => ac.abort();
        signal.addEventListener("abort", onParentAbort, { once: true });
        cascadeOff = () =>
          signal.removeEventListener("abort", onParentAbort);
      }
    }

    const handle = makeHandle({
      id,
      parentId: parentCtx.parentId,
      role,
      prompt: input.prompt,
      background,
      provider,
      model,
      onCancel: async () => {
        if (!ac.signal.aborted) ac.abort();
      },
    });

    const entry: PoolEntry = {
      handle,
      ac,
      cascadeOff,
      done: undefined as unknown as Promise<void>, // assigned below
    };
    this.map.set(id, entry);

    emitTelemetry({
      type: "subagent.spawn",
      id,
      parentId: handle.parentId,
      role,
      background,
    });

    // Timeout watchdog — fires childAc.abort() and tags reason on the
    // eventual subagent.end. Resolved status is `failed` (not `cancelled`)
    // because it's a runtime-side termination, not user intent.
    // step-19: precedence is caller input > role def > global default.
    const timeoutMs = input.timeoutMs ?? roleDef?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      entry.timer = setTimeout(() => {
        if (isTerminal(handle)) return;
        timedOut = true;
        ac.abort();
      }, timeoutMs);
    }

    const work = this.runChild(handle, entry, input, opts.parentCtx, roleDef, () => timedOut);
    entry.done = work;

    if (background) {
      // Fire-and-forget. We still observe completion to clear the timer
      // and emit subagent.end, but the caller continues immediately. The
      // promise rejection (if any) is logged, not bubbled.
      work.catch((err) => {
        logger.warn("sub-agent background run threw", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return handle;
    }

    await work;
    return handle;
  }

  private async runChild(
    handle: MutableSubAgentHandle,
    entry: PoolEntry,
    input: SpawnInput,
    parentCtx: ParentRuntimeCtx,
    roleDef: BuiltInAgentDefinition | undefined,
    timedOutRef: () => boolean,
  ): Promise<void> {
    setStatus(handle, "running");

    // step-19: merge role definition defaults. Precedence:
    //   caller input  >  role def  >  global default.
    const maxRounds = input.maxRounds ?? roleDef?.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const budgetUSD = input.budgetUSD ?? roleDef?.budgetUSD ?? DEFAULT_BUDGET_USD;

    const provider: ProviderId = input.provider ?? roleDef?.preferredProvider ?? parentCtx.parentProvider;
    const model = input.model ?? roleDef?.preferredModel ?? parentCtx.parentModel;

    // Tool-list merge (AGENTS.md §5 least-privilege: caller can only tighten,
    // never widen, a role's pool).
    const toolAllowlist = mergeAllowlist(input.tools, roleDef?.allowedTools);
    const toolDenylist = mergeDenylist(input.disallowedTools, roleDef?.disallowedTools);

    // Build the agent-layer prompt. shareSession defaults to true; when
    // false (or systemPromptOverride is set) the parent snapshot is
    // skipped to keep the child fully isolated.
    const shareSession = input.shareSession ?? true;
    const snapshot = input.contextSnapshotOverride
      ?? buildParentSnapshot(parentCtx.parentMessages, parentCtx.parentRole, {
        objective: parentCtx.parentObjective,
      });

    // step-19: build the SystemContext the role's getSystemPrompt sees. The
    // memoryText / notesText fields stay empty here — step-25 (TMT injection)
    // fills them. cwd/model/planMode are the same inputs the 5-layer builder
    // uses for the default layer, so the role prompt can adapt to them.
    const systemCtx: SystemContext = {
      cwd: { cwd: process.cwd() },
      model: { provider, model },
      planMode: false,
    };

    const systemPromptOpts = buildSystemPromptOpts({
      role: handle.role,
      prompt: input.prompt,
      shareSession,
      snapshot,
      override: input.systemPromptOverride,
      roleDef,
      systemCtx,
    });

    const initialMessages: ChatMessage[] = [
      { role: "user", content: input.prompt, ts: Date.now() },
    ];

    const startedAt = handle.spawnedAt;
    let result: SubAgentResult;

    try {
      const engine = new QueryEngine();
      const run = await engine.run({
        messages: initialMessages,
        systemPromptOpts,
        provider,
        model,
        toolAllowlist,
        toolDenylist,
        permissionMode: input.permissionMode ?? parentCtx.parentMode,
        abortSignal: entry.ac.signal,
        agentRole: handle.role,
        agentId: handle.id,
        parentId: handle.parentId,
        maxRounds,
        budgetUSD,
        // step-22: tap the child's streaming / tool / usage hooks to drive
        // live UI progress. The parent's onUsage / onMessage hooks don't
        // apply to children; we observe via the handle + outputBuffer +
        // swarmBus instead. These are best-effort — a throwing callback
        // must never break the run, so each wraps in try/catch.
        onToken: (delta) => {
          try {
            appendOutput(handle.id, delta);
          } catch {
            /* swallow — UI-only */
          }
        },
        onToolStart: (name) => {
          try {
            setPhase(handle, phaseForTool(name));
          } catch {
            /* swallow — UI-only */
          }
        },
        onUsage: (usage) => {
          try {
            addUsage(handle, usage);
          } catch {
            /* swallow — UI-only */
          }
        },
      });

      handle.tokensIn = run.tokens.in;
      handle.tokensOut = run.tokens.out;

      if (run.stopReason === "cancelled") {
        const reason = timedOutRef()
          ? `timeout after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : "cancelled by parent";
        result = {
          ok: false,
          content: run.finalContent || "",
          costUSD: run.costUSD,
          reason,
        };
        finalize(handle, result, timedOutRef() ? "failed" : "cancelled");
      } else if (run.stopReason === "budgetExceeded") {
        result = {
          ok: false,
          content: run.finalContent || "",
          costUSD: run.costUSD,
          reason: `budget exceeded (${run.costUSD.toFixed(4)} > ${budgetUSD})`,
        };
        finalize(handle, result, "failed");
      } else if (run.stopReason === "maxRounds") {
        result = {
          ok: false,
          content: run.finalContent || "",
          costUSD: run.costUSD,
          reason: `maxRounds reached (${maxRounds})`,
        };
        finalize(handle, result, "failed");
      } else {
        result = {
          ok: true,
          content: run.finalContent,
          costUSD: run.costUSD,
        };
        finalize(handle, result, "done");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("sub-agent run threw", { id: handle.id, error: msg });
      result = {
        ok: false,
        content: "",
        costUSD: handle.costUSD,
        reason: msg,
      };
      finalize(handle, result, "failed");
    } finally {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      entry.cascadeOff?.();
      entry.cascadeOff = undefined;
      // step-22: mark the output buffer finished (retained for AgentDetail
      // but eligible for TTL eviction) and opportunistically sweep cold ones.
      markFinished(handle.id);
      evictExpired();
    }

    emitTelemetry({
      type: "subagent.end",
      id: handle.id,
      parentId: handle.parentId,
      status: handle.status,
      costUSD: handle.costUSD,
      durMs: (handle.finishedAt ?? Date.now()) - startedAt,
    });
  }
}

// ── step-22: tool-name → live phase label ─────────────────────────────────
//
// Maps the tool a sub-agent just started running into a short human-readable
// phase string for the SwarmPanel row (`⏳ reading file foo.ts`). Kept here
// (not in lifecycle.ts) because the mapping is a UI concern; the runtime
// type stays UI-agnostic. Unknown tools fall back to `running <name>`.

const TOOL_PHASE: Record<string, string> = {
  read: "reading file",
  write: "writing file",
  edit: "editing file",
  glob: "finding files",
  grep: "searching content",
  bash: "running command",
  web_search: "searching web",
  web_fetch: "fetching page",
  todo_write: "updating todos",
};

function phaseForTool(name: string): string {
  return TOOL_PHASE[name] ?? `running ${name}`;
}

// ── step-19: tool-list merge helpers ───────────────────────────────────────
//
// Caller-supplied tool lists merge with a role definition's lists under
// least-privilege: the caller can only TIGHTEN a role's pool, never widen it.
//   - allowlist: intersection (stricter wins). If only one side sets a
//     whitelist, that side wins; if neither, undefined (full pool).
//   - denylist:  union (both layers' denials apply).
// Exported (prefixed `_`) so smoke-step19 can unit-test the merge directly
// without spinning up a pool + provider stub.

/**
 * Merge caller `tools` with a role's `allowedTools`. Returns the effective
 * whitelist (`undefined` = no whitelist, full pool applies).
 *
 * Empty arrays are treated as "no whitelist supplied" (no-op), NOT "allow
 * nothing" — an accidental `[]` must not brick a sub-agent. If you genuinely
 * want to block every tool, use `disallowedTools` with the full tool list.
 *
 *   caller=["bash"], role=["bash","file_read"]  → ["bash"]      (intersection)
 *   caller=undefined, role=["bash","file_read"] → ["bash","file_read"]
 *   caller=["bash"], role=undefined             → ["bash"]
 *   caller=undefined, role=undefined            → undefined
 *   caller=[], role=[]                          → []            (no-op → role)
 */
export function _mergeAllowlistForTesting(
  caller: string[] | undefined,
  role: string[] | undefined,
): string[] | undefined {
  return mergeAllowlist(caller, role);
}

function mergeAllowlist(
  caller: string[] | undefined,
  role: string[] | undefined,
): string[] | undefined {
  if (!caller || caller.length === 0) return role;
  if (!role || role.length === 0) return caller;
  const roleSet = new Set(role);
  // Intersection preserves caller order (deterministic for PSF / tests).
  return caller.filter((t) => roleSet.has(t));
}

/**
 * Merge caller `disallowedTools` with a role's `disallowedTools`. Returns
 * the effective blacklist (`undefined` = no blacklist). Union — both layers'
 * denials apply; de-duplicated, role order first then caller-only entries.
 */
export function _mergeDenylistForTesting(
  caller: string[] | undefined,
  role: string[] | undefined,
): string[] | undefined {
  return mergeDenylist(caller, role);
}

function mergeDenylist(
  caller: string[] | undefined,
  role: string[] | undefined,
): string[] | undefined {
  if (!caller || caller.length === 0) return role;
  if (!role || role.length === 0) return caller;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of role) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const t of caller) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ── module-singleton (the runtime has exactly one pool per process) ───────

let singleton: SubAgentPool | undefined;

export function getSubAgentPool(): SubAgentPool {
  if (!singleton) singleton = new InMemoryPool();
  return singleton;
}

/**
 * Test-only escape hatch — replace the singleton with a fresh pool. The
 * production code path never calls this; keeping it here avoids exposing
 * the class.
 */
export function _resetSubAgentPoolForTesting(): void {
  if (singleton) singleton.reset();
  singleton = undefined;
}

// ── prompt-options helper ─────────────────────────────────────────────────

interface BuildPromptOptsArgs {
  role: AgentRole;
  prompt: string;
  shareSession: boolean;
  snapshot: import("../types/index.js").ParentContextSnapshot;
  override?: string;
  /** step-19: built-in role definition (undefined for main/custom). */
  roleDef?: BuiltInAgentDefinition;
  /** step-19: context handed to `roleDef.getSystemPrompt(ctx)`. */
  systemCtx: SystemContext;
}

/**
 * Compose `BuildOptions` for the sub-agent's system prompt builder
 * (`prompts/builders.ts`):
 *   - Layer 0 (override): when caller passes `systemPromptOverride`.
 *   - Layer 2 (agent): role-specific text + optional snapshot envelope.
 *
 * The `agent.prompt` slot intentionally carries the snapshot envelope as a
 * prefix so the builder doesn't need to learn about snapshots — it stays
 * a pure 5-layer composer.
 *
 * step-19: when a `roleDef` is present, the role text comes from
 * `roleDef.getSystemPrompt(ctx)` (rich, role-specific) and `omitMemory` is
 * taken from the role def. When absent (main/custom), we fall back to the
 * minimal `<agent-role>` marker so PSF can still distinguish sub-agent runs.
 */
function buildSystemPromptOpts(
  args: BuildPromptOptsArgs,
): Partial<BuildOptions> {
  if (args.override) {
    return { override: args.override };
  }
  // step-19: prefer the role definition's dynamic prompt; fall back to the
  // minimal role marker for unregistered roles (main/custom).
  const rolePrompt = args.roleDef
    ? args.roleDef.getSystemPrompt(args.systemCtx)
    : `<agent-role>${args.role}</agent-role>`;
  const agentText = args.shareSession
    ? `${formatSnapshotXml(args.snapshot)}\n\n${rolePrompt}`
    : rolePrompt;
  return {
    agent: {
      role: args.role,
      prompt: agentText,
      omitMemory: args.roleDef?.omitMemory ?? false,
    },
  };
}
