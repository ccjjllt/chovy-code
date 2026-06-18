import { z } from "zod";
import type { Tool, ToolResult } from "../types/index.js";

/**
 * Reference v2 tool — echoes its input back verbatim. Used by the agent
 * loop smoke test to validate end-to-end tool wiring without touching the
 * filesystem, network, or permissions.
 *
 * Shape choices (per `docs/step-06-tool-protocol-v2.md`):
 *   - `family: "meta"` — not destructive, not even a side-effect.
 *   - `isReadOnly: true` and `canUseWithoutAsk: true` — the permission
 *     engine (step-12) will fast-path to `allow` without prompting.
 *   - `desc.lean` is one sentence; `desc.full` adds a usage hint. The ATP
 *     allocator (step-07) decides which to inject per turn.
 *   - Returns a structured `ToolResult` even though `string` would also be
 *     accepted by the back-compat layer; new tools should follow this
 *     pattern as a worked example.
 */
export const echoTool: Tool = {
  name: "echo",
  version: 2,
  family: "meta",
  desc: {
    lean: "Echo back the provided message. Smoke-test only.",
    full:
      "Echo back the provided message verbatim. Useful for validating the " +
      "agent loop end-to-end before any real tools are wired up. Returns " +
      "the input string unchanged with no side effects.",
    examples: [`echo({ message: "hello" })  →  "hello"`],
  },
  schema: z.object({
    message: z.string().describe("The text to echo back."),
  }),
  isReadOnly: true,
  canUseWithoutAsk: true,
  // Permission preflight: read-only meta tool, always allow.
  checkPermissions() {
    return { outcome: "allow" };
  },
  async run(args): Promise<ToolResult> {
    return {
      ok: true,
      content: args.message,
      meta: { bytes: args.message.length },
    };
  },
};
