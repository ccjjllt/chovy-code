/**
 * `/checkpoint` slash command (step-26).
 *
 * Subcommands:
 *   /checkpoint           — alias for `/checkpoint now`
 *   /checkpoint now       — force an immediate checkpoint
 *   /checkpoint list      — list archived checkpoints (basename + size + ts)
 *
 * Per AGENTS.md §16 the slash handler is **UI-only** — it never imports
 * `memory/checkpointWriter` (the REPL closes over the live provider /
 * model / cwd / message tail and exposes the narrow `ReplCheckpointRuntime`
 * surface). This keeps `cli/slashCommands` a leaf module.
 */

import type { SlashEntry } from "../slashCommands.js";

const HELP =
  "/checkpoint now | list (or just /checkpoint to force one now)";

export const checkpointSlashEntry: SlashEntry = {
  help:
    "立即生成 / 列出 checkpoint（/checkpoint now | list）",
  handler: async (args, ctx) => {
    const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const runtime = ctx.checkpoint;
    if (!runtime) {
      ctx.appendSystem(
        "[checkpoint] runtime unavailable in this context " +
          "(REPL-only — headless mode uses goal-loop's auto-trigger).",
      );
      return;
    }

    if (sub === "" || sub === "now") {
      ctx.appendSystem("[checkpoint] generating snapshot…");
      try {
        const status = await runtime.triggerNow();
        ctx.appendSystem(`[checkpoint] ${status}`);
      } catch (err) {
        ctx.appendSystem(
          `[checkpoint] failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    if (sub === "list") {
      try {
        const items = await runtime.list();
        if (items.length === 0) {
          ctx.appendSystem("[checkpoint] (none)");
          return;
        }
        const lines = items.map(
          (i) => `  ${i.name}  ${i.bytes}B  ${i.ts}`,
        );
        ctx.appendSystem(
          `[checkpoint] ${items.length} archived:\n` + lines.join("\n"),
        );
      } catch (err) {
        ctx.appendSystem(
          `[checkpoint] list failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    ctx.appendSystem(`[checkpoint] usage: ${HELP}`);
  },
};
