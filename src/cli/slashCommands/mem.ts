/**
 * `/mem` slash command (step-24 store + step-25 injection).
 *
 * Subcommands:
 *   /mem                  — usage help (aliases: list/search/show/stats)
 *   /mem list [--layer l] [--type t] [--limit n]
 *                         — top records by importance (default limit 20)
 *   /mem show <id>        — pretty-print one record
 *   /mem search <query> [--bm25] [--limit n] [--layer l]
 *                         — FTS5 BM25 / mixed-rank search
 *   /mem stats            — record count + path + degraded flag
 *
 * Per AGENTS.md §16 the slash handler is **UI-only** — it never imports
 * `src/memory/` directly (the REPL closes over cwd and exposes the narrow
 * `ReplMemRuntime` surface so each call opens a synced store). This keeps
 * `cli/slashCommands` a leaf module, mirroring `/checkpoint` / `/skill`.
 *
 * Output formatting mirrors the `chovy mem ...` CLI (`src/cli/index.tsx`)
 * so REPL and headless read identically.
 */

import type { SlashEntry } from "../slashCommands.js";

const HELP =
  "/mem list | show <id> | search <query> | stats (see --help-style flags below)\n" +
  "  /mem list [--layer project|checkpoint|notes|progress] [--type decision|rule|fact|pref|note|reference|snapshot|progress] [--limit N]\n" +
  "  /mem show <id>\n" +
  "  /mem search <query> [--bm25] [--limit N] [--layer <l>]\n" +
  "  /mem stats";

/** Parse `--flag value` / `--flag` tokens out of an arg string. */
function parseFlags(
  raw: string,
): { positional: string[]; flags: Record<string, string | boolean> } {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function intOf(v: string | boolean | undefined, fallback: number): number {
  if (typeof v !== "string") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const memSlashEntry: SlashEntry = {
  help: "记忆查询（/mem list|show|search|stats）",
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    const sp = trimmed.indexOf(" ");
    const sub = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
    const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
    const runtime = ctx.mem;

    if (!runtime) {
      ctx.appendSystem(
        "[mem] runtime unavailable in this context " +
          "(REPL-only — headless mode uses `chovy mem ...`).",
      );
      return;
    }

    // No subcommand (or plain "/mem") → usage.
    if (sub === "" || sub === "help") {
      ctx.appendSystem(`[mem] usage:\n${HELP}`);
      return;
    }

    if (sub === "list") {
      const { flags } = parseFlags(rest);
      try {
        const items = await runtime.list({
          layer: typeof flags.layer === "string" ? flags.layer : undefined,
          type: typeof flags.type === "string" ? flags.type : undefined,
          limit: intOf(flags.limit, 20),
        });
        if (items.length === 0) {
          ctx.appendSystem("[mem] (no matching records)");
          return;
        }
        ctx.appendSystem(
          `[mem] ${items.length} records:\n` + items.map((i) => i.line).join("\n"),
        );
      } catch (err) {
        ctx.appendSystem(`[mem] list failed: ${errMsg(err)}`);
      }
      return;
    }

    if (sub === "show") {
      const { positional } = parseFlags(rest);
      const id = positional[0];
      if (!id) {
        ctx.appendSystem("[mem] usage: /mem show <id>");
        return;
      }
      try {
        const res = await runtime.show(id);
        if (!res.found) {
          ctx.appendSystem(`[mem] id "${id}" not found`);
          return;
        }
        ctx.appendSystem(`[mem] ${id}:\n${res.block ?? ""}`);
      } catch (err) {
        ctx.appendSystem(`[mem] show failed: ${errMsg(err)}`);
      }
      return;
    }

    if (sub === "search") {
      // Query is the remaining text minus flags. Use positional tokens joined.
      const { positional, flags } = parseFlags(rest);
      const query = positional.join(" ").trim();
      if (!query) {
        ctx.appendSystem("[mem] usage: /mem search <query>");
        return;
      }
      try {
        const items = await runtime.search(query, {
          bm25: flags.bm25 === true,
          limit: intOf(flags.limit, 10),
          layer: typeof flags.layer === "string" ? flags.layer : undefined,
        });
        if (items.length === 0) {
          ctx.appendSystem("[mem] (no matches)");
          return;
        }
        ctx.appendSystem(
          `[mem] ${items.length} matches for "${query}":\n` +
            items.map((i) => i.line).join("\n"),
        );
      } catch (err) {
        ctx.appendSystem(`[mem] search failed: ${errMsg(err)}`);
      }
      return;
    }

    if (sub === "stats") {
      try {
        const res = await runtime.stats();
        ctx.appendSystem(`[mem] stats:\n${res.block}`);
      } catch (err) {
        ctx.appendSystem(`[mem] stats failed: ${errMsg(err)}`);
      }
      return;
    }

    ctx.appendSystem(`[mem] unknown subcommand: ${sub}\nusage:\n${HELP}`);
  },
};
