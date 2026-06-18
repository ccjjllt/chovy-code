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
 * Permission engine handle (placeholder until step-12).
 *
 * Tools should *not* call this directly today; they MAY rely on it being
 * present in `ToolContext` once step-12 lands. The interface is intentionally
 * thin so step-12 can extend it without breaking step-06 consumers.
 *
 * TODO step-12: replace with the real engine in
 * `src/harness/permissions/engine.ts`.
 */
export interface PermissionEngine {
  /** Run the full 6-layer decision; step-12 supplies the implementation. */
  preflight?(toolName: string, args: unknown): Promise<PermissionPreflight>;
}

/**
 * Hook engine handle (placeholder until step-13).
 *
 * TODO step-13: replace with the real engine in
 * `src/harness/hooks/engine.ts`.
 */
export interface HookEngine {
  /** Fire a hook event (PreToolUse/PostToolUse/...); step-13 wires it up. */
  emit?(event: string, payload: unknown): Promise<void>;
}

/**
 * Sub-agent spawn function (placeholder until step-18).
 *
 * The exact request/response shape is owned by step-18's sub-agent runtime;
 * the field is optional in `ToolContext` for now so tools that don't need
 * fan-out behavior compile cleanly.
 *
 * TODO step-18: replace with `(req: SpawnRequest) => Promise<SubAgentHandle>`.
 */
export type SpawnFn = (req: unknown) => Promise<unknown>;

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
  /** Live `ChovyConfig` snapshot. Tools MUST treat this as read-only. */
  config: ChovyConfig;
  /** Session id. Used by memory/telemetry/UI panels. */
  sessionId: string;
  /** Project id (hash of cwd). */
  projectId: string;
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
   * may return a `string` and the harness wraps it as
   * `{ ok: true, content: <string> }`. The `ctx` argument is optional in
   * the type so legacy tools that ignore it keep compiling.
   */
  run(
    args: z.infer<T>,
    ctx?: ToolContext,
  ): Promise<string | ToolResult>;

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
