/**
 * Agent / sub-agent type contracts.
 *
 * Frozen by:
 *   - step-18 (sub-agent runtime — `SubAgentHandle`, `AgentLifecycle`,
 *     `SubAgentResult`, `SpawnInput`, `SpawnFn`, `ParentContextSnapshot`)
 *   - step-19 (built-in agents — `BuiltInAgentDefinition` finalized to the
 *     spec shape: `whenToUse` + `getSystemPrompt(ctx)` + budget/timeout/
 *     maxRounds; the step-01 draft `systemPrompt: string` field is removed)
 *
 * Design note (step-18 freeze): step-18 spec uses the descriptive name
 * `AgentStatus` for the lifecycle union, but chovy-code's single-source for
 * this union is `AgentLifecycle` (already shipped in step-01 and consumed
 * by `architecture.md §4.1`). `AgentStatus` is kept as a type alias for
 * documentation parity, not a separate union.
 *
 * Single-source rules (AGENTS.md §16):
 *   - `AgentRole` lives here; `telemetry/events.ts` re-exports via
 *     `export type` and never re-declares.
 *   - `SpawnFn` lives here; `types/tool.ts` consumes it via `import type`
 *     for `ToolContext.spawnSubAgent`.
 */
import type { ChatMessage } from "./messages.js";
import type { ProviderId } from "./provider.js";
import type { PermissionMode } from "../config/config.js";
import type { SystemContext } from "../prompts/builders.js";

/** Roles a (sub-)agent can play. The four built-in roles ship in step-19. */
export type AgentRole =
  | "main"
  | "explorer"
  | "planner"
  | "verifier"
  | "critic"
  | "checkpoint-writer"
  | "custom";

/**
 * Lifecycle status for any (sub-)agent. Mirrors the state machine in
 * `architecture.md §4.1` and `docs/step-18 §SubAgentHandle 与状态机`.
 *
 *   queued → running ─┬─▶ done
 *                     ├─▶ failed
 *                     ├─▶ cancelled
 *                     └─▶ paused (goal-loop pauses; step-23)
 *   paused → running   (resume; step-23)
 */
export type AgentLifecycle =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "paused";

/**
 * Documentation alias matching step-18 spec's `AgentStatus`. Code MUST use
 * `AgentLifecycle` everywhere; `AgentStatus` exists only so external readers
 * comparing the spec to the source see the same name.
 */
export type AgentStatus = AgentLifecycle;

/**
 * Final result handed back to the parent when a sub-agent terminates.
 * Frozen at step-18; downstream layers (Swarm aggregator, Goal loop) read
 * `content` for the model-facing transcript and `structuredOutput` for
 * programmatic consumers (e.g. judge schemas in step-21).
 */
export interface SubAgentResult {
  ok: boolean;
  /** Final assistant content. Empty string when the agent was cancelled
   *  before producing output. */
  content: string;
  /** Optional structured payload (judge schema, plan template, etc.). */
  structuredOutput?: unknown;
  /** Cumulative spend across all rounds executed by this sub-agent. */
  costUSD: number;
  /** Termination reason. Filled when status is `cancelled` / `failed` /
   *  budget / timeout; absent on clean `done`. */
  reason?: string;
}

/**
 * A handle to a running sub-agent (step-18 freeze; consumed by SwarmR
 * step-20 and the Ink panel step-22 — UI code MUST treat fields as
 * read-only snapshots and observe `status` to know when fields are
 * final).
 *
 * The previous draft typed `result?: ChatMessage[]` — step-18 promotes it
 * to `SubAgentResult` (the freeze point in `architecture.md §3.3` allows
 * the draft → frozen tightening; no production code accessed the old
 * field, only `goal.ts` held the array of handles).
 */
export interface SubAgentHandle {
  id: string;                       // "sa_" + base36(8)
  parentId: string;
  role: AgentRole;
  prompt: string;
  status: AgentLifecycle;
  /** Free-form phase label, e.g. "exploring-files". The runtime updates
   *  this; the model can update its own via the `phase` field on tool
   *  outputs (step-22 will surface it in the UI). */
  phase: string;
  spawnedAt: number;
  finishedAt?: number;
  costUSD: number;
  tokensIn: number;
  tokensOut: number;
  /** Optional provider override; falls back to parent. */
  provider?: ProviderId;
  /** Optional model override; falls back to parent. */
  model?: string;
  /** True when the parent dispatched the agent with `run_in_background`. */
  background: boolean;
  /**
   * Cooperative cancel. Idempotent: calling on a `done` / `failed` /
   *  `cancelled` handle resolves immediately. Triggers the child's
   *  internal `AbortController` (never the parent's — AGENTS.md §9).
   */
  cancel(): Promise<void>;
  /** Set when status reaches `done` / `failed` / `cancelled`. */
  result?: SubAgentResult;
}

/**
 * Parent → child context snapshot (step-18 spec §"上下文共享"). The runtime
 * builds one of these from the parent's live message tail (and, after
 * step-25/26 land, the parent's MEMORY/checkpoint summaries) and feeds it
 * into the sub-agent's Layer-2 (`agent`) system prompt slot.
 *
 * NAMING: step-18 spec calls this `ContextSnapshot`, but `types/context.ts`
 * already owns that name for SCW (step-27/28). Renamed to
 * `ParentContextSnapshot` to avoid collision; the verification report
 * (`docs/complete/step-18-acceptance.md`) records the rename.
 */
export interface ParentContextSnapshot {
  /** Most recent K parent messages (default K = 6). */
  recentMessages: ChatMessage[];
  /** Top-K MEMORY.md / TMT injections. Empty until step-25. */
  memorySummary: string;
  /** Active task progress.md excerpt. Undefined until step-26. */
  activeTaskProgress?: string;
  /** Key decisions captured by checkpoint-writer. Empty until step-26. */
  decisions: string[];
  parentRole: AgentRole;
  /** Current `/goal` objective when running under the goal loop. */
  parentObjective?: string;
}

/**
 * Caller-supplied input to `spawnSubAgent` / the `agent` meta tool.
 *
 * The runtime fills sensible defaults for everything except `prompt`.
 * `parentCtx` is reserved for the in-process factory (`createSpawnFn`)
 * — the model / tool layer never supplies it.
 */
export interface SpawnInput {
  role?: AgentRole;
  prompt: string;
  provider?: ProviderId;
  model?: string;
  /** Tool whitelist by name; intersected with the runtime tool pool. */
  tools?: string[];
  /** Tool blacklist by name; subtracted from the pool. */
  disallowedTools?: string[];
  /** Replaces the entire system prompt (skips the 5-layer builder). */
  systemPromptOverride?: string;
  /** Inject the parent snapshot into the agent layer? Default `true`. */
  shareSession?: boolean;
  /** Detach so the parent can keep working. Default `false`. */
  background?: boolean;
  /** USD spend cap per sub-agent. Default 0.20. */
  budgetUSD?: number;
  /** Wall-clock cap in ms. Default 120_000 (120s). */
  timeoutMs?: number;
  /** Tool-call round cap. Default 12. */
  maxRounds?: number;
  /** Permission mode override. Default = parent's mode. */
  permissionMode?: PermissionMode;
  /** Bypass the live snapshot and inject a caller-built one. */
  contextSnapshotOverride?: ParentContextSnapshot;
  /**
   * Parent runtime context — supplied by `createSpawnFn` inside the
   * agent factory. The model / tool layer MUST NOT pass this.
   */
  parentCtx?: ParentRuntimeCtx;
}

/**
 * Live parent execution context, threaded by the in-process factory
 * `createSpawnFn` (`src/agent/runAgent.ts`). Exists so the pool can
 *   - copy parent's message tail into a snapshot,
 *   - cascade abort from parent to child without sharing the signal,
 *   - inherit provider / model / mode when the spawn input omits them.
 */
export interface ParentRuntimeCtx {
  /** Parent agent id (becomes `parentId` on the child handle). */
  parentId: string;
  parentRole: AgentRole;
  parentProvider: ProviderId;
  parentModel: string;
  parentMode?: PermissionMode;
  /** Snapshot source: most recent parent messages. The pool slices this. */
  parentMessages: ChatMessage[];
  /** Parent's abort signal. The child wires a *listener* to cascade abort
   *  via its own AbortController — never shared (AGENTS.md §9). */
  parentSignal?: AbortSignal;
  /** Optional `/goal` objective for `<parent-session-snapshot>`. */
  parentObjective?: string;
}

/**
 * Sub-agent spawn function (frozen at step-18). Tools / coordinator code
 * call this via `ctx.spawnSubAgent`. The factory in
 * `src/agent/runAgent.ts` constructs an instance bound to the live
 * parent run; the legacy `(req: unknown) => Promise<unknown>` shape on
 * `ToolContext` (step-06 placeholder) is replaced by this contract.
 */
export type SpawnFn = (input: SpawnInput) => Promise<SubAgentHandle>;

/**
 * Definition for a built-in agent role (frozen at step-19).
 *
 * Each built-in role ships: a `whenToUse` blurb surfaced to the parent
 * agent (so it knows when to pick this role), a tool whitelist/blacklist,
 * a provider/model preference, an `omitMemory` flag, optional budget /
 * timeout / maxRounds overrides, and a `getSystemPrompt(ctx)` factory that
 * produces the Layer-2 (`agent`) prompt fragment.
 *
 * Precedence when a sub-agent spawns (AGENTS.md §5 least-privilege):
 *   caller `SpawnInput` field  >  role definition field  >  global default
 *   (DEFAULT_BUDGET_USD / DEFAULT_MAX_ROUNDS / DEFAULT_TIMEOUT_MS in pool.ts)
 *
 * Tool-list merging (caller can only *tighten*, never widen, a role's pool):
 *   - `allowedTools` (whitelist): caller `tools` ∩ role `allowedTools`
 *     (intersection — the stricter of the two wins). If only one side sets a
 *     whitelist, that side wins; if neither does, the full pool is used.
 *   - `disallowedTools` (blacklist): caller `disallowedTools` ∪ role
 *     `disallowedTools` (union — both layers' denials apply).
 * A role SHOULD set at most one of `allowedTools` / `disallowedTools`; if it
 * sets both, the whitelist is applied first and the blacklist subtracted.
 *
 * `getSystemPrompt(ctx)` is dynamic so a role can adapt to `cwd` / `model` /
 * `planMode` (e.g. Verify writes the project's test command into its prompt).
 * The `ctx` is the same `SystemContext` the 5-layer builder uses; step-25
 * will fill `memoryText` / `notesText` (currently empty for sub-agents).
 */
export interface BuiltInAgentDefinition {
  role: AgentRole;
  /** Surfaced to the parent agent as "what is this role for". */
  whenToUse: string;
  /** Optional human-readable alias (docs / `chovy agent list`). */
  description?: string;
  /** Tool whitelist by name (intersected with caller's `tools`). */
  allowedTools?: string[];
  /** Tool blacklist by name (unioned with caller's `disallowedTools`). */
  disallowedTools?: string[];
  /** Provider preference; falls back to parent if unset. */
  preferredProvider?: ProviderId;
  /**
   * Model preference; falls back to parent if unset. Roles that want a
   * small/long-context model set this; `undefined` means "inherit parent".
   */
  preferredModel?: string;
  /** When true, this agent does NOT see parent memory (least context). */
  omitMemory?: boolean;
  /** USD spend cap override for this role. */
  budgetUSD?: number;
  /** Wall-clock cap override for this role (ms). */
  timeoutMs?: number;
  /** Tool-call round cap override for this role. */
  maxRounds?: number;
  /**
   * Produce the Layer-2 (`agent`) system prompt fragment. The pool prepends
   * the parent-session snapshot envelope to this text before handing it to
   * the 5-layer builder. Returning the empty string is legal (the role then
   * gets only the snapshot + default prompt).
   */
  getSystemPrompt(ctx: SystemContext): string;
}
