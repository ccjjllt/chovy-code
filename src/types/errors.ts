/**
 * Unified error model for chovy-code.
 *
 * Every error that crosses a module boundary SHOULD be wrapped in a
 * `ChovyError` so the harness, logger, and UI can react on a stable
 * `code` rather than parsing message strings.
 *
 * The logger (step-03) recognizes the canonical formatted line
 * `chovy.error: <CODE> <message>` produced by `formatChovyError`.
 *
 * Design notes:
 * - Codes are a closed string-literal union, *not* a TS enum, because the
 *   project's tsconfig enables `erasableSyntaxOnly` (enums are forbidden).
 * - `ChovyError` declares its fields explicitly instead of using parameter
 *   properties, again because of `erasableSyntaxOnly`.
 * - `cause` is forwarded to the standard ES2022 `Error` constructor and is
 *   surfaced via inheritance (`err.cause`); we don't redeclare it.
 */

/** Stable error codes. New codes MUST be added here, never invented ad-hoc. */
export type ErrorCode =
  // Provider layer
  | "PROVIDER_NOT_READY"
  | "PROVIDER_API_ERROR"
  | "PROVIDER_RATE_LIMIT"
  // Tool layer
  | "TOOL_NOT_FOUND"
  | "TOOL_INVALID_ARGS"
  | "TOOL_DENIED"
  | "TOOL_TIMEOUT"
  // step-07: ATP allocator could not fit even the lean baseline; some tools
  // were dropped from the descriptor set. Emitted as a *warning*, never thrown.
  | "TOOL_BUDGET"
  // Permission / hook
  | "PERMISSION_DENIED"
  | "PERMISSION_HOOK_BLOCKED"
  // Context
  | "CTX_OVERFLOW"
  | "CTX_REBUILD_FAILED"
  // Memory
  | "MEMORY_IO"
  | "MEMORY_INDEX_CORRUPT"
  // Agent / sub-agent
  | "AGENT_CANCELLED"
  | "AGENT_BUDGET_EXCEEDED"
  | "AGENT_TIMEOUT"
  // Goal loop
  | "GOAL_DIVERGED"
  | "GOAL_MAX_ROUNDS"
  // Misc
  | "CONFIG_INVALID"
  | "INTERNAL";

/**
 * A single, structured error type. Carries a stable `code`, a
 * human-readable `message`, an optional underlying `cause`, and arbitrary
 * `meta` for the logger / telemetry sink.
 */
export class ChovyError extends Error {
  readonly code: ErrorCode;
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    cause?: unknown,
    meta?: Record<string, unknown>,
  ) {
    // ES2022 Error supports an `options.cause` second argument.
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChovyError";
    this.code = code;
    this.meta = meta;
  }

  toJSON(): {
    name: string;
    code: ErrorCode;
    message: string;
    meta?: Record<string, unknown>;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      meta: this.meta,
    };
  }
}

/**
 * Type guard. Uses `name` instead of `instanceof` so it works across
 * realms (e.g. when an error is rehydrated from a worker / IPC).
 */
export function isChovyError(e: unknown): e is ChovyError {
  return e instanceof Error && (e as Error).name === "ChovyError";
}

/**
 * Format an error in the canonical log shape recognized by the logger
 * (step-03). Keeping this side-effect-free here avoids a logger->errors
 * dependency cycle later.
 */
export function formatChovyError(e: ChovyError): string {
  return `chovy.error: ${e.code} ${e.message}`;
}
