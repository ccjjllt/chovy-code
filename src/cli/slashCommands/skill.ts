/**
 * `/skill` slash command (step-29 — CSG).
 *
 * Subcommands:
 *   /skill                  — alias for `/skill list`
 *   /skill list             — list registered skills (name / provides / requires)
 *   /skill show <name>      — print a skill's full systemFragment
 *   /skill plan             — dry-run: show what the planner would activate
 *                             given the latest user text + manual locks
 *   /skill <name> [args]    — manually activate a skill (and its requires)
 *   /skill clear            — clear all manual activations + active fragments
 *
 * Per AGENTS.md §16 the slash handler is **UI-only** — it imports `src/skills/`
 * (a leaf module) but never the engine / providers. The REPL closes over
 * cwd / threadId via `ReplSkillRuntime` (see `slashCommands.ts`).
 */
import type { SlashEntry } from "../slashCommands.js";
import { t } from "../../i18n/index.js";

export const skillSlashEntry: SlashEntry = {
  help: t("slash.skill.desc"),
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    const parts = trimmed.split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? "";
    const runtime = ctx.skill;
    if (!runtime) {
      ctx.appendSystem(
        "[skill] runtime unavailable in this context " +
          "(REPL-only — slash skill activation needs the live ToolSession).",
      );
      return;
    }

    if (sub === "" || sub === "list") {
      try {
        const items = await runtime.list();
        if (items.length === 0) {
          ctx.appendSystem("[skill] (no skills registered)");
          return;
        }
        const lines = items.map((s) => {
          const reqs = s.requires.length > 0 ? `requires=${s.requires.join(",")}` : "";
          const provs = s.provides.length > 0 ? `provides=${s.provides.join(",")}` : "";
          const conf = s.conflicts.length > 0 ? `conflicts=${s.conflicts.join(",")}` : "";
          const meta = [reqs, provs, conf, `tokens=${s.budgetTokens}`].filter(Boolean).join(" ");
          const active = s.active ? " [ACTIVE]" : "";
          const manual = s.manual ? " [MANUAL]" : "";
          return `  ${s.name}${active}${manual}\n    ${s.summary}\n    ${meta}`;
        });
        ctx.appendSystem(`[skill] ${items.length} registered:\n${lines.join("\n")}`);
      } catch (err) {
        ctx.appendSystem(`[skill] list failed: ${errMsg(err)}`);
      }
      return;
    }

    if (sub === "show") {
      const name = parts[1]?.trim();
      if (!name) {
        ctx.appendSystem(`[skill] usage: /skill show <name>`);
        return;
      }
      try {
        const body = await runtime.show(name);
        if (body == null) {
          ctx.appendSystem(`[skill] unknown skill: ${name}`);
          return;
        }
        ctx.appendSystem(`[skill] ${name}:\n${body}`);
      } catch (err) {
        ctx.appendSystem(`[skill] show failed: ${errMsg(err)}`);
      }
      return;
    }

    if (sub === "plan") {
      try {
        const dryRun = await runtime.plan();
        if (dryRun.selected.length === 0) {
          ctx.appendSystem(
            `[skill] planner would activate: (none)\n  intent tags: ${dryRun.tags.join(", ") || "(empty)"}`,
          );
          return;
        }
        const lines = [
          `  selected: ${dryRun.selected.join(", ")}`,
          `  totalTokens: ${dryRun.totalTokens} / ${dryRun.budgetTokens}`,
          dryRun.droppedByBudget.length > 0
            ? `  droppedByBudget: ${dryRun.droppedByBudget.join(", ")}`
            : "",
          dryRun.droppedByConflict.length > 0
            ? `  droppedByConflict: ${dryRun.droppedByConflict.join(", ")}`
            : "",
          dryRun.missingRequired.length > 0
            ? `  missingRequired: ${dryRun.missingRequired.join(", ")}`
            : "",
          `  intent tags: ${dryRun.tags.slice(0, 12).join(", ")}`,
        ].filter(Boolean);
        ctx.appendSystem(`[skill] plan dry-run:\n${lines.join("\n")}`);
      } catch (err) {
        ctx.appendSystem(`[skill] plan failed: ${errMsg(err)}`);
      }
      return;
    }

    if (sub === "clear") {
      try {
        await runtime.clear();
        ctx.appendSystem(`[skill] cleared all manual activations and active fragments.`);
      } catch (err) {
        ctx.appendSystem(`[skill] clear failed: ${errMsg(err)}`);
      }
      return;
    }

    // Treat anything else as a direct activation: /skill <name> [args]
    const name = sub;
    const argsStr = parts.slice(1).join(" ").trim();
    try {
      const result = await runtime.activate(name, argsStr.length > 0 ? argsStr : undefined);
      ctx.appendSystem(`[skill] ${result}`);
    } catch (err) {
      ctx.appendSystem(`[skill] activate failed: ${errMsg(err)}`);
    }
  },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
