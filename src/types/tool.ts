import type { z } from "zod";
import type { ChovyConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { ErrorCode } from "./errors.js";

/**
 * Tool Protocol v2 (step-06).
 *
 * Goals (from `docs/step-06-tool-protocol-v2.md`):
 *   1. Promote `Tool` from a flat schema+run pair to a richer contract that
 *      carries the metadata downstream layers (ATP, permissions, hooks,
 *      sub-agents, UI) need.
 *   2. Adopt the **ATP** lean/full description pair as a first-class field
 *      so step-07's Tool Budget Allocator can pick at runtime which one
 *      enters the system prompt.
 *   3. Freeze a `ToolContext` that future steps wire up (cwd, abort signal,
 *      logger handle, permission engine, hook engine, sub-agent spawn fn,
 *      live config snapshot, session/project ids).
 *   4. Widen the result shape so tools can return structured output and
 *      side-effect metadata (filesChanged / cmd / durMs / bytes) — not just
 *      a model-facing string.
 *   5. Provide a per-tool permission preflight that the step-12 engine can
 *      call before executing; today it returns a simple allow/ask/deny.
 *
 * Back-compat:
 *   - The legacy `description` field is preserved (optional). The registry
 *     and the agent loop fill it from `desc.lean` when only `desc` is set.
 *   - `run()` may return *either* a `string` (legacy) *or* a `ToolResult`
 *     (v2). The agent loop wraps strings as `{ ok: true, content: string }`
 *     before pushing them onto the message list.
 *   - Existing optional fields from the step-01 draft (`descriptions`,
 *     `ToolPermissionDecision`, `ToolContextDraft`, `ToolResultDraft`) are
 *     re-exported as deprecated aliases so any in-flight code keeps
 *     compiling.
 */

// ── Families ───────────────────────────────────────────────────────────────

/**
 * Tool families — used by ATP (step-06/07) for budget allocation,
 * permission grouping (step-12), and analytics. The set is closed: pick the
 * closest fit, or `"custom"` for one-offs.
 *
 * The string broadening is a deliberate escape hatch for plugins that ship
 * their own family axis; in-tree tools MUST stick to the literal set.
 */
export type ToolFamily =
  | "fs"
  | "exec"
  | "web"
  | "meta"
  | "echo"
  | "custom"
  // Plugin escape hatch; do not use in built-in tools.
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  | (string & {});

// ── Descriptions (ATP) ─────────────────────────────────────────────────────

/**
 * Lean/full description pair. The Tool Budget Allocator (step-07) picks one
 * per request based on the remaining context budget, recent messages, and
 * the previous round's tool calls.
 *
 * Conventions:
 *   - `lean` MUST be a single sentence, ~80–150 tokens. It is *always* safe
 *     to inject — even at the tightest budgets.
 *   - `full` may include examples, edge cases, and safety notes. The ATP
 *     allocator only upgrades to `full` if budget allows AND the tool is
 *     deemed relevant to the current turn.
 *   - `examples` are completely optional. They are only attached to `full`
 *     when budget headroom permits; otherwise they are dropped.
 */
export interface ToolDescriptions {
  lean: string;
  full: string;
  examples?: string[];
}

// ── Permissions (preflight) ────────────────────────────────────────────────

/**
 * Outcome of a tool's own permission preflight (the *first* layer of the
 * 6-layer engine that lands in step-12). The engine merges this with
 * config rules, mode, hooks, sandbox, and user prompt to produce the final
 * decision; preflight is purely advisory.
 */
export interface PermissionPreflight {
  outcome: "allow" | "ask" | "deny";
  reason?: string;
  /** Content-specific rule that matched, e.g. `"Bash(git push:*)"`. */
  matchedRule?: string;
}

// ── Runtime context ────────────────────────────────────────────────────────

/**
 * Permission engine handle (step-12).
 *
 * Tools should *not* call this directly today; they MAY rely on it being
 * present in `ToolContext` so they can re-query a decision (rare). The
 * interface is intentionally thin: the agent loop runs the full 6-layer
 * `hasPermission` (in `src/harness/permissions/engine.ts`) before every
 * `tool.run`, and binds `preflight` here as a thin adapter that delegates
 * to the same engine + live state. Downstream steps (13/14) extend the
 * engine; this handle stays stable.
 */
export interface PermissionEngine {
  /** Run the full 6-layer decision; step-12 supplies the implementation. */
  preflight?(toolName: string, args: unknown): Promise<PermissionPreflight>;
}

/**
 * Hook engine handle (step-13).
 *
 * The `emit` field name was frozen at step-06; step-13 adds the optional
 * `runPermissionRequest` handle (adding optional fields is permitted,
 * renaming is not — AGENTS.md §18). The agent loop injects a real engine
 * from `src/harness/hooks/engine.ts`; the permission engine's L5 calls
 * `runPermissionRequest` to race the user prompt. The full interface
 * (HookEvent / HookOutcome / HookContext / HookPermissionDecision) is
 * frozen in `./hook.ts` — that file is the single source; this module
 * imports it (not re-exports) so the barrel has no duplicate export.
 */
import type { HookEngine } from "./hook.js";

/**
 * Sub-agent spawn function. Single source: `types/agent.ts` (step-18 freeze).
 *
 * The legacy `(req: unknown) => Promise<unknown>` placeholder shipped in
 * step-06 was replaced when step-18 froze `SubAgentHandle` / `SpawnInput`.
 * `ToolContext.spawnSubAgent` now references the strong-typed contract.
 *
 * NOTE: only `import type` here — re-exporting via the barrel (which
 * already wildcards `agent.ts`) would duplicate the export and break the
 * barrel build (mirrors the `HookEngine` pattern below).
 */
import type { SpawnFn } from "./agent.js";

// ── Step-11 meta-tool plumbing ─────────────────────────────────────────────

/**
 * SwarmR dispatch entry exposed to tools (step-20). The dispatch meta tool
 * calls `ctx.dispatchSwarm(...)` instead of re-implementing fan-out; the
 * QueryEngine injects a handle bound to the live parent runtime context
 * (mirroring the `spawnSubAgent` pattern). Absent for sub-agent runs and
 * any context that hasn't wired SwarmR — the tool refuses with `INTERNAL`.
 *
 * Single source: the router lives in `src/swarm/router.ts`; this type is the
 * thin contract so `types/tool.ts` doesn't import the swarm module (which
 * would cycle swarm → types → swarm).
 */
export type DispatchSwarmFn = (
  input: import("../swarm/router.js").DispatchInput,
) => Promise<import("../swarm/router.js").DispatchOutput>;

/**
 * A single todo entry (step-11 `TodoWrite`). Mirrors cc-haha's TodoWrite
 * shape so users moving between agents see the same fields. The `id` is
 * optional in the wire schema; when absent the tool assigns by index.
 */
export interface TodoItem {
  /** Optional caller-supplied id; absent ⇒ positional by array index. */
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "low" | "medium" | "high";
}

/**
 * Per-session state the meta tools read/write (step-11).
 *
 * `todoList` is the agent's own task list — the model writes it via
 * `TodoWrite` and the UI (step-22 / step-30) renders a live panel. Kept on
 * `ToolContext.session` rather than a global so sub-agents (step-18) each
 * get their own list and so tests can inject a fresh store.
 */
export interface ToolSession {
  /** Agent-maintained todo list. Undefined ⇒ "no list yet" (read as empty). */
  todoList?: TodoItem[];

  /**
   * step-29 (CSG) addition (frozen-extension; AGENTS.md §16).
   *
   * Active skill systemFragments keyed by `Skill.name`. Two writers:
   *   - The CSG planner (`src/engine/skillHook.ts:runSkillRound`) populates
   *     this each round when `CHOVY_SKILLS_AUTO=1` / `feature('skills.auto')`
   *     is on. The planner replaces the auto-selected subset wholesale.
   *   - `SkillTool.run` (manual mode) merges entries here when the user /
   *     model invokes `skill({ skill: 'commit' })`. Manual entries are
   *     marked with `manual=true` (carried in a sibling map below) so the
   *     planner can preserve them across rounds.
   *
   * The prompt builder (`src/engine/skillHook.ts` → `runHelpers.fillBuildOptions`
   * → `SystemContext.skillFragments`) reads this map each round and emits a
   * `<skill name="...">` block via `skillFragmentsSection`.
   *
   * Undefined ⇒ "no skills active" (treat as empty map). Storing the bodies
   * (not just names) avoids re-rendering on every prompt build and keeps the
   * fragment text stable across rounds even if the registry changes.
   */
  activeSkillFragments?: Record<string, string>;

  /**
   * Names of skills the user / model activated *manually* (via SkillTool or
   * `/skill <name>`). Distinct from auto-selected names so the planner can
   * keep them across rounds without re-scoring. Subset of
   * `Object.keys(activeSkillFragments)`. Frozen-extension; optional.
   */
  manualSkillNames?: string[];
}

/**
 * One selectable option for `AskUserQuestion` (step-11).
 */
export interface AskUserOption {
  label: string;
  description: string;
  preview?: string;
}

/**
 * One question the agent wants to surface to the user (step-11).
 */
export interface AskUserQuestionSpec {
  question: string;
  /** Short chip label; UI truncates at ~12 chars. */
  header: string;
  multiSelect?: boolean;
  options: AskUserOption[];
}

/**
 * Answer payload returned by the UI layer (step-22). For single-select the
 * value is the chosen `label` (or `"Other"` + free text); for multi-select
 * it's a comma-joined list of labels.
 */
export type AskUserAnswer = Record<string, string>;

/**
 * Interactive prompt callback injected by the UI layer (step-22). The meta
 * tool `AskUserQuestion` delegates to this when present; when absent the
 * tool returns `INTERNAL` pointing at step-22 so the model learns the UI
 * isn't wired yet instead of hanging.
 *
 * TODO step-22: the Ink `AskUserOverlay` supplies a real implementation.
 */
export type AskUserFn = (
  questions: AskUserQuestionSpec[],
  signal?: AbortSignal,
) => Promise<AskUserAnswer>;

/**
 * Permission prompt callback injected by the UI layer (step-30+).
 */
export type AskPermissionFn = (
  toolName: string,
  args: any,
  reason: string,
  signal?: AbortSignal,
) => Promise<"allow" | "deny" | "always">;

/**
 * Whether the host process can render an interactive prompt. The CLI sets
 * this from `process.stdin.isTTY` (see step-05's `startRepl`); non-interactive
 * (`chat "..."`, `goal`, sub-agents) report `false` so `AskUserQuestion`
 * refuses cleanly per `docs/step-11-meta-tools.md §"风险"`.
 */
export type IsInteractiveFn = () => boolean;

/**
 * Runtime context handed to a tool's `run` (and `checkPermissions`) in v2.
 *
 * The field set is *frozen* at step-06 — downstream steps may add optional
 * fields, but renaming or removing one is a breaking change that requires a
 * version bump on `Tool.version`.
 */
export interface ToolContext {
  /** Working directory for path resolution. */
  cwd: string;
  /** Honored by long-running tools. Sub-agents get their own signals. */
  abortSignal: AbortSignal;
  /** Structured logger; tools MUST use this instead of `console.*`. */
  logger: Logger;
  /** Permission engine (step-12). Placeholder shape today. */
  permissions: PermissionEngine;
  /** Hook engine (step-13). Placeholder shape today. */
  hooks: HookEngine;
  /** Sub-agent dispatch entry (step-18); absent for tools that don't fan out. */
  spawnSubAgent?: SpawnFn;
  /**
   * SwarmR dispatch entry (step-20). The dispatch meta tool fans N prompts
   * out to N sub-agents via this handle. Absent for sub-agent runs (only the
   * top-level `main` role gets one — see QueryEngine spawn wiring) so a
   * sub-agent can't recursively dispatch without an explicit future opt-in.
   */
  dispatchSwarm?: DispatchSwarmFn;
  /** Live `ChovyConfig` snapshot. Tools MUST treat this as read-only. */
  config: ChovyConfig;
  /** Session id. Used by memory/telemetry/UI panels. */
  sessionId: string;
  /** Project id (hash of cwd). */
  projectId: string;

  // ── step-11 additions (all optional; safe for step-06 call sites) ─────────

  /**
   * Per-session state for the meta tools (`TodoWrite`). The agent loop
   * (step-16) injects a fresh object per agent run; absent ⇒ meta tools fall
   * back to a module-level store so they work today and tests stay isolated.
   */
  session?: ToolSession;

  /**
   * Interactive-prompt callback for `AskUserQuestion`. Absent ⇒ the tool
   * refuses with `INTERNAL` pointing at step-22 (the Ink overlay that wires
   * this up). The CLI additionally gates on `isInteractive` below.
   *
   * TODO step-22: `AskUserOverlay` supplies the real implementation.
   */
  askUser?: AskUserFn;

  /**
   * Interactive permission prompt callback. The PermissionEngine delegates
   * to this when L6 requires a prompt.
   */
  askPermission?: AskPermissionFn;

  /**
   * Reports whether the host process can render an interactive prompt.
   * Defaults to checking `process.stdin.isTTY`; sub-agents (step-18) and the
   * one-shot `chat "..."` path report `false` so `AskUserQuestion` refuses
   * instead of deadlocking waiting for stdin.
   */
  isInteractive?: IsInteractiveFn;

  /**
   * step-26 addition (frozen-extension; AGENTS.md §16).
   *
   * Identifies the role of the agent that owns this `ToolContext`. The agent
   * loop (`engine/queryEngine.ts`) populates it from `QueryRunOptions.agentRole`
   * — the pool plumbs `handle.role` through for sub-agents; the main loop
   * leaves it as `"main"` (or undefined for legacy callers). Tools may use
   * it to do role-aware behavior (least-privilege checks, role-scoped
   * formatting). Specifically:
   *
   *   - `file_write` / `file_edit` deny writes outside `checkpointDir(cwd)`
   *     when `agentRole === "checkpoint-writer"` (step-26 path sandbox).
   *
   * Treat `undefined` as "main" for permissive behavior (back-compat with
   * any in-tree call site that hasn't been updated). New role-gated checks
   * MUST be opt-in (deny only when role explicitly matches).
   */
  agentRole?: import("./agent.js").AgentRole;
}

// ── Result ─────────────────────────────────────────────────────────────────

/**
 * Side-effect metadata attached to a `ToolResult`. Optional in every field
 * — tools fill in only what applies. The harness aggregates these for the
 * Ink status line, telemetry, and post-task summaries.
 */
export interface ToolResultMeta {
  /** Files the tool created, modified, or deleted (project-relative paths). */
  filesChanged?: string[];
  /** Command the tool ran (e.g. for `bash` / `webFetch`). */
  cmd?: string;
  /** Wall-clock duration in milliseconds. */
  durMs?: number;
  /** Bytes read or written. */
  bytes?: number;
}

/**
 * Structured tool result (v2). The agent loop reads `content` for the
 * model-facing message; the UI reads `structuredOutput` and `meta`.
 */
export interface ToolResult {
  ok: boolean;
  /** Text given back to the model. */
  content: string;
  /** Structured payload for the UI / programmatic consumers. */
  structuredOutput?: unknown;
  /** Side-effect metadata (filesChanged / cmd / durMs / bytes). */
  meta?: ToolResultMeta;
  /** Error code (set when `ok === false`). */
  errorCode?: ErrorCode;
}

// ── Tool ───────────────────────────────────────────────────────────────────

/**
 * Optional render hook. Kept loose (`unknown`) at this layer because the
 * Ink renderer lives in `src/cli/components/` and we don't want a UI dep
 * leaking into the type module. The UI side casts to `ReactNode`.
 *
 * TODO step-22: tighten to `React.ReactNode` once the agent UI lands.
 */
export type ToolRenderFn<TArgs = unknown> = (
  args: TArgs,
  result: ToolResult,
) => unknown;

/**
 * The v2 Tool contract. New tools SHOULD set `desc`, `family`, and return
 * `ToolResult` from `run`. Legacy tools that only set `description` and
 * return a `string` keep working — the registry and agent loop adapt them.
 */
export interface Tool<T extends z.ZodType = z.ZodType> {
  /** Stable, unique name (snake_case). The model uses this to call the tool. */
  name: string;

  /** Protocol version; defaults to `2` for tools that set `desc`. */
  version?: 1 | 2;

  /** Family used by ATP (step-07) to enforce same-family `full` exclusivity. */
  family?: ToolFamily;

  /** ATP lean/full pair. Preferred over `description` for v2 tools. */
  desc?: ToolDescriptions;

  /**
   * Trigger patterns — when the user's recent messages match any regex,
   * the ATP allocator forces this tool to `full`. Optional; absent =
   * relevance-driven decision only.
   */
  fullTriggers?: RegExp[];

  /** Zod schema describing the tool's arguments. */
  schema: T;

  /**
   * User-facing label for status-line / UI. Falls back to `name` when
   * absent. May read args (e.g. `"Read README.md"`).
   */
  userFacingName?(args: z.infer<T>): string;

  /**
   * `true` when the tool only reads state. Defaults to `family === "fs"`
   * with no `Write`/`Edit` semantic; concrete tools MUST set this
   * explicitly. The permission engine (step-12) reads this for plan-mode
   * gating.
   */
  isReadOnly?: boolean;

  /** When `true`, the engine skips the user prompt for `ask` outcomes. */
  canUseWithoutAsk?: boolean;

  /**
   * Self-preflight permission check (layer 1 of the engine in step-12).
   * Optional — engines treat absence as `allow` for read-only tools and
   * `ask` for everything else.
   */
  checkPermissions?(
    args: z.infer<T>,
    ctx: ToolContext,
  ): Promise<PermissionPreflight> | PermissionPreflight;

  /**
   * Execute the tool. v2 tools MUST return a `ToolResult`; legacy tools
   * may return a `string` (sync or async) and the harness wraps it as
   * `{ ok: true, content: <string> }`. The `ctx` argument is optional in
   * the type so legacy tools that ignore it keep compiling.
   */
  run(
    args: z.infer<T>,
    ctx?: ToolContext,
  ): string | ToolResult | Promise<string | ToolResult>;

  /** Optional Ink renderer (step-22). */
  renderResult?: ToolRenderFn<z.infer<T>>;

  // ── Legacy fields (kept for back-compat with step-01 tools) ──────────────
  /**
   * Single-line description (legacy v1 field). When `desc` is set this
   * SHOULD be omitted; the registry derives it from `desc.lean`. Kept
   * here so existing tools (e.g. the original `echoTool`) compile without
   * changes.
   */
  description?: string;
}

// ── Wire-format descriptor (legacy; kept for callers that import it) ───────

/**
 * Minimal descriptor handed to providers that want a JSON-Schema-like shape.
 * Step-07 supersedes this with `DescribedTool` from `src/tools/describe.ts`,
 * which carries the lean/full level. The plain descriptor is kept as a
 * thin wire format for providers that don't need ATP awareness.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

// ── Deprecated aliases (step-01 draft surface) ─────────────────────────────

/**
 * @deprecated Use `PermissionPreflight` instead. Step-01 modeled tool
 * permission outcomes with a tagged union; v2 collapses it onto the
 * preflight shape used by every layer of the engine.
 */
export type ToolPermissionDecision =
  | { type: "allow" }
  | { type: "ask"; reason?: string }
  | { type: "deny"; code: ErrorCode; reason: string };

/**
 * @deprecated Use `ToolContext` instead. Held over from the step-01 draft.
 */
export type ToolContextDraft = ToolContext;

/**
 * @deprecated Use `ToolResult` instead. The step-01 draft carried a
 * provider-assigned `callId`; that id is now plumbed through the agent loop
 * via the `ToolCall` type in `messages.ts`, not the result.
 */
export interface ToolResultDraft {
  callId: string;
  ok: boolean;
  output: string;
  payload?: unknown;
  errorCode?: ErrorCode;
}
