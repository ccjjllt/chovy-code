import type { z } from "zod";
import type { ErrorCode } from "./errors.js";

/**
 * Tool families — used by ATP (step-06/07) for budget allocation,
 * permission grouping, and analytics. The set is closed: pick the closest
 * fit, or `"custom"` for one-offs.
 */
export type ToolFamily = "fs" | "exec" | "web" | "meta" | "echo" | "custom";

/**
 * Lean / full description pair. The Tool Budget Allocator (step-07)
 * chooses which to inject based on the remaining context budget.
 *
 * - `lean`  — short, ~1 sentence; cheap; always safe to inject.
 * - `full`  — long, with examples / edge cases; injected when budget allows.
 */
export interface ToolDescriptions {
  lean: string;
  full: string;
}

/**
 * v2 permission gate (DRAFT). The full state machine lives in step-12
 * (`src/harness/permissions/engine.ts`). `ask` defers to the engine; the
 * engine may then escalate to a hook (step-13) or to the user.
 */
export type ToolPermissionDecision =
  | { type: "allow" }
  | { type: "ask"; reason?: string }
  | { type: "deny"; code: ErrorCode; reason: string };

/**
 * A tool the agent can invoke. Each tool declares its argument schema (zod)
 * and an async `run` handler. Tools are registered in `src/tools/index.ts`.
 *
 * Step-01 keeps the original required surface unchanged. Steps 06–07 add
 * `descriptions`, `family`, and `checkPermissions` — these are optional
 * here so existing tools (e.g. `echo`) keep compiling unmodified.
 */
export interface Tool<T extends z.ZodType = z.ZodType> {
  /** Stable, unique name. The model uses this to call the tool. */
  name: string;
  /** One-line description shown to the model. */
  description: string;
  /** Zod schema describing the tool's arguments. */
  schema: T;
  /** Execute the tool. Return a string result for the model. */
  run(args: z.infer<T>): Promise<string>;

  // ── ATP draft (step-06/07; optional until then) ─────────────────────────
  /** Lean/full description pair; runtime-selected by Tool Budget Allocator. */
  descriptions?: ToolDescriptions;
  /** Tool family; used for budgeting, permissions, and analytics. */
  family?: ToolFamily;
  /**
   * Permission gate. Default behavior in step-12 is to require `ask` for
   * any tool that does not declare this method.
   */
  checkPermissions?: (
    args: z.infer<T>,
  ) => ToolPermissionDecision | Promise<ToolPermissionDecision>;
}

/** Minimal description handed to providers that want a JSON-schema-like shape. */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/**
 * DRAFT of the runtime context handed to a tool's `run` in v2 (step-06).
 *
 * Pinned here only as a *signature anchor* so other phases can import the
 * type while step-06 is still in flight. Step-06 owns the real wiring
 * (cwd resolution, abort propagation, logger handle).
 *
 * TODO step-06: replace `log` shape with the structured logger from step-03.
 */
export interface ToolContextDraft {
  /** Working directory for path resolution. */
  cwd: string;
  /** Honored by long-running tools. */
  signal: AbortSignal;
  /** Logger handle; concrete type lands in step-03. */
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
}

/**
 * DRAFT of the structured tool result returned in v2 (step-06). The
 * legacy `ToolResult` in `messages.ts` stays as the wire format consumed
 * by `agent.ts`; v2 will widen it with `payload` and `errorCode`.
 */
export interface ToolResultDraft {
  callId: string;
  ok: boolean;
  output: string;
  /** Optional structured payload for the UI (step-22). */
  payload?: unknown;
  /** Optional error code (set when `ok === false`). */
  errorCode?: ErrorCode;
}
