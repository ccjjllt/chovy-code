/**
 * Tool execution helpers for the QueryEngine (step-16).
 *
 * Extracted from `queryEngine.ts` so the main file stays under the
 * ≤600-line cap mandated by `docs/step-16-query-engine.md §风险` and
 * AGENTS.md §8. The split is mechanical — these helpers carry no engine
 * state of their own and rely entirely on what the caller threads in
 * (ctx / permState / opts / cancelGraceMs). All telemetry single-source
 * invariants from AGENTS.md §16 (`tool.call` emitted exactly once per
 * tool invocation) are preserved here.
 */
import type { ZodType } from "zod";
import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { getTool } from "../tools/index.js";
import { hasPermission, type PermissionEngineState } from "../harness/permissions/index.js";
import type {
  ChatMessage,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
} from "../types/index.js";

/**
 * Subset of `QueryRunOptions` consumed by the tool executor. Kept narrow
 * so the helper does not import the full options type (and so callers
 * other than QueryEngine — e.g. tests, future sub-agent drivers — can
 * reuse it without dragging the whole engine surface).
 */
export interface ToolExecutorOpts {
  onToolStart?(name: string, args: unknown): void;
  onToolEnd?(name: string, result: ToolResult): void;
}

/**
 * Run a single tool call: hook → permission → schema parse → run →
 * post-hook. Returns the `tool` ChatMessage to push onto the transcript.
 *
 * Telemetry: emits exactly one `tool.call` event (single source per
 * AGENTS.md §16). Hook failures are advisory and never poison the tool
 * result (post-hook errors are logged but do not flip `ok`).
 */
export async function executeToolCall(
  call: ToolCall,
  ctx: ToolContext,
  permState: PermissionEngineState,
  opts: ToolExecutorOpts,
  cancelGraceMs: number,
): Promise<ChatMessage> {
  const tool = getTool(call.name);
  if (!tool) {
    logger.warn(`Unknown tool requested: ${call.name}`);
    emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
    return {
      role: "tool",
      toolName: call.name,
      content: `Error: unknown tool "${call.name}"`,
      ts: Date.now(),
    };
  }

  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    args = {};
  }
  opts.onToolStart?.(call.name, args);

  const parsed = (tool.schema as ZodType).safeParse(args);
  if (!parsed.success) {
    emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
    const message = `Error: invalid arguments — ${parsed.error.message}`;
    opts.onToolEnd?.(call.name, { ok: false, content: message, errorCode: "TOOL_DENIED" });
    return {
      role: "tool",
      toolName: call.name,
      content: message,
      ts: Date.now(),
    };
  }

  // PreToolUse hook: a `block` outcome short-circuits.
  if (ctx.hooks?.emit) {
    try {
      const pre = await ctx.hooks.emit("PreToolUse", {
        toolName: call.name,
        toolArgs: parsed.data,
      });
      if (pre.type === "block") {
        emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
        const message = `Blocked by PreToolUse hook: ${pre.reason}`;
        opts.onToolEnd?.(call.name, {
          ok: false,
          content: message,
          errorCode: "TOOL_DENIED",
        });
        return {
          role: "tool",
          toolName: call.name,
          content: message,
          ts: Date.now(),
        };
      }
    } catch (err) {
      logger.warn("PreToolUse hook threw", {
        tool: call.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6-layer permission engine.
  const decision = await hasPermission(tool, parsed.data, ctx, permState);
  if (decision.outcome !== "allow") {
    emitTelemetry({ type: "tool.call", tool: call.name, ok: false, durMs: 0 });
    if (ctx.hooks?.emit && decision.outcome === "deny") {
      try {
        await ctx.hooks.emit("PermissionDenied", {
          toolName: call.name,
          toolArgs: parsed.data,
          error: decision.reason,
        });
      } catch { /* swallowed inside emit; defensive */ }
    }
    const message =
      decision.outcome === "deny"
        ? `Permission denied: ${decision.reason}`
        : `Permission pending (ask): ${decision.reason}`;
    opts.onToolEnd?.(call.name, {
      ok: false,
      content: message,
      errorCode: "TOOL_DENIED",
    });
    return {
      role: "tool",
      toolName: call.name,
      content: message,
      ts: Date.now(),
    };
  }

  const startedAt = Date.now();
  let ok = true;
  let output: string;
  let toolResult: ToolResult;
  try {
    const raw = await invokeTool(tool, parsed.data, ctx, cancelGraceMs);
    if (typeof raw === "string") {
      output = raw;
      toolResult = { ok: true, content: raw };
    } else {
      ok = raw.ok;
      output = raw.content;
      toolResult = raw;
    }
  } catch (err) {
    ok = false;
    output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    toolResult = { ok: false, content: output, errorCode: "INTERNAL" };
  }
  emitTelemetry({
    type: "tool.call",
    tool: call.name,
    ok,
    durMs: Date.now() - startedAt,
  });

  if (ctx.hooks?.emit) {
    try {
      if (ok) {
        await ctx.hooks.emit("PostToolUse", {
          toolName: call.name,
          toolArgs: parsed.data,
          result: output,
        });
      } else {
        await ctx.hooks.emit("PostToolUseFailure", {
          toolName: call.name,
          toolArgs: parsed.data,
          error: output,
        });
      }
    } catch (err) {
      logger.warn("PostToolUse hook threw", {
        tool: call.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  opts.onToolEnd?.(call.name, toolResult);
  return {
    role: "tool",
    toolName: call.name,
    content: output,
    ts: Date.now(),
  };
}

/**
 * Invoke the tool with a soft cancel-grace window: if the abort signal
 * fires while the tool is running, we wait at most `cancelGraceMs` for
 * it to return on its own (most v2 tools observe `ctx.abortSignal`),
 * then surface a synthesized "cancelled" result. We never force-kill
 * the JS task — any kill semantics live inside the tool (e.g. the bash
 * tool's killTree).
 */
export async function invokeTool(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  cancelGraceMs: number,
): Promise<string | ToolResult> {
  const exec = Promise.resolve(tool.run(args, ctx));
  if (!ctx.abortSignal) return exec;

  return await new Promise<string | ToolResult>((resolve, reject) => {
    let settled = false;
    const settle = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      cb();
    };
    const onAbort = (): void => {
      // Give the tool `cancelGraceMs` to return; otherwise return a
      // structured cancellation result. Don't reject — callers expect a
      // ToolResult so the message list stays consistent.
      const t = setTimeout(() => {
        settle(() =>
          resolve({
            ok: false,
            content: "Tool cancelled by user (timed out waiting for graceful exit).",
            errorCode: "INTERNAL",
          }),
        );
      }, cancelGraceMs);
      // Race: if the tool *does* finish during the grace window, the
      // exec.then below will settle first.
      exec.finally(() => clearTimeout(t));
    };
    if (ctx.abortSignal.aborted) onAbort();
    else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    exec.then(
      (v) => settle(() => resolve(v)),
      (e) => settle(() => reject(e)),
    );
  });
}
