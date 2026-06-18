/**
 * `todo_write` — agent-maintained task list (step-11).
 *
 * Per `docs/step-11-meta-tools.md`:
 *   - Persists to `ctx.session.todoList` (in-memory); when `ctx.session` is
 *     absent (agent loop doesn't pass `ctx` yet — step-16 owns that wiring)
 *     the tool falls back to a module-level store so it works today and
 *     tests stay isolated.
 *   - Caps at 50 entries; `in_progress` items MUST be ≤ 1 (matches cc-haha's
 *     "one in flight" rule so the model doesn't claim to do everything at
 *     once).
 *   - Writes are *replacements*, not appends: the agent passes the full
 *     intended list every time. When ids are present the merge is id-based;
 *     when ids are absent it is positional-by-index (the spec's "idempotent
 *     on id 缺失则按下标" criterion).
 *   - Emits one `tool.call` telemetry event (via the agent-loop wrapper) and
 *     a `todo.wrote` event carrying the before/after counts so step-22 can
 *     surface progress in the status line.
 *
 * Why a module-level fallback store at all? The agent loop in step-16 is the
 * owner of `ToolContext.session`, and the smoke test must run before step-16
 * lands. Mirrors the pattern `src/tools/web/fetch.ts` uses for its URL cache:
 * a module-level mutable cell that the production path (`ctx`) supersedes.
 */

import { z } from "zod";

import { logger } from "../../logger/index.js";
import type {
  PermissionPreflight,
  Tool,
  ToolContext,
  ToolResult,
  TodoItem,
} from "../../types/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_ITEMS = 50;

const argsSchema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().optional(),
        content: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed"]),
        priority: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(MAX_ITEMS, `todo_write accepts at most ${MAX_ITEMS} items`),
});

type Args = z.infer<typeof argsSchema>;

// ── Module-level fallback store ────────────────────────────────────────────

/**
 * Used only when `ctx.session.todoList` is not wired (today: the agent loop
 * doesn't pass `ctx`; step-16 owns the injection). Once step-16 lands, every
 * production call reads/writes `ctx.session.todoList` and this store is only
 * touched by tests that deliberately omit `ctx`.
 *
 * Keyed by `sessionId` so two concurrent smoke runs (rare, but possible in a
 * test harness) don't clobber each other. Falls back to `"default"` when the
 * caller passes no `ctx` at all.
 */
const stores = new Map<string, TodoItem[]>();

function storeFor(ctx: ToolContext | undefined): {
  list: TodoItem[];
  sessionBacked: boolean;
} {
  if (ctx?.session) {
    if (!ctx.session.todoList) ctx.session.todoList = [];
    return { list: ctx.session.todoList, sessionBacked: true };
  }
  const sid = ctx?.sessionId ?? "default";
  let list = stores.get(sid);
  if (!list) {
    list = [];
    stores.set(sid, list);
  }
  return { list, sessionBacked: false };
}

/** Test helper: reset the module-level store. Production code never calls it. */
export function _resetTodoStoreForTesting(): void {
  stores.clear();
}

// ── Merge logic ────────────────────────────────────────────────────────────

/**
 * Replace `current` with `incoming`, preserving ids when present and falling
 * back to positional merge otherwise (spec's "idempotent on id 缺失则按下标").
 *
 * Semantics:
 *   - Empty `incoming` ⇒ clear (return `[]`). This lets the agent drop the
 *     whole list with `todo_write({ todos: [] })`.
 *   - Item WITH `id`:
 *       • if `current` has an item with the same id ⇒ update that slot;
 *       • otherwise append as a new item.
 *   - Item WITHOUT `id`:
 *       • update `current[i]` if it exists (positional), otherwise append.
 *
 * Mixed id/no-id inputs are allowed — ids update their named slot, positional
 * items walk a shared cursor that skips slots already claimed by an id update.
 * This keeps the tool forgiving for a model that sometimes forgets to echo
 * ids back: a fully-positional list behaves as a verbatim replacement, while
 * a single id'd item behaves as a targeted patch that leaves the rest alone.
 *
 * Implementation: a sparse array `out` is built to the length of `current`.
 * Each incoming item claims either its matched id-slot or the next free
 * positional slot (a monotonic cursor). After processing, unfilled slots
 * keep their original `current` value; trailing appends extend the array.
 */
function mergeTodos(current: TodoItem[], incoming: Args["todos"]): TodoItem[] {
  if (incoming.length === 0) return [];

  // Start from a shallow copy of current so un-touched slots keep their item.
  const out: (TodoItem | undefined)[] = current.slice();
  const idToSlot = new Map<string, number>();
  current.forEach((t, i) => {
    if (t.id) idToSlot.set(t.id, i);
  });
  const claimedSlots = new Set<number>();

  // Positional cursor: index of the next free slot to use for an id-less
  // item. Walks forward, skipping slots already claimed by an id update.
  let positionalCursor = 0;

  for (const t of incoming) {
    if (t.id) {
      const slot = idToSlot.get(t.id);
      if (slot !== undefined) {
        // Update the existing slot in place.
        out[slot] = { ...t };
        claimedSlots.add(slot);
        continue;
      }
      // New id — append at the end.
      out.push({ ...t });
      continue;
    }
    // Positional item — find the next free slot at/after the cursor.
    while (positionalCursor < out.length && claimedSlots.has(positionalCursor)) {
      positionalCursor++;
    }
    if (positionalCursor < current.length) {
      // Update an existing positional slot.
      out[positionalCursor] = { ...t };
      claimedSlots.add(positionalCursor);
      positionalCursor++;
    } else {
      // Past the end of current — append.
      out.push({ ...t });
    }
  }

  // `out` may still hold `undefined` only if current had fewer items than we
  // indexed — can't happen given the logic above, but filter defensively.
  return out.filter((t): t is TodoItem => t !== undefined);
}

/**
 * Enforce the "≤ 1 in_progress" rule from the spec. If the model sends more
 * than one, we keep the FIRST in_progress and demote the rest to `pending`
 * (rather than rejecting the whole write — losing the whole list would be a
 * worse UX). The demotion is logged + surfaced in the result so the model
 * learns the constraint.
 */
function enforceSingleInFlight(list: TodoItem[]): { demoted: number } {
  let seenInFlight = false;
  let demoted = 0;
  for (const t of list) {
    if (t.status === "in_progress") {
      if (seenInFlight) {
        t.status = "pending";
        demoted++;
      } else {
        seenInFlight = true;
      }
    }
  }
  return { demoted };
}

// ── Tool ───────────────────────────────────────────────────────────────────

export const todoWriteTool: Tool<typeof argsSchema> = {
  name: "todo_write",
  version: 2,
  family: "meta",
  isReadOnly: false, // mutates the todo list
  canUseWithoutAsk: true, // bookkeeping only — no external side effects

  desc: {
    lean:
      "Maintain the agent's task list. Pass the FULL intended list each call " +
      "(replacement, not append); ≤1 item may be in_progress.",
    full:
      "Maintain the agent's in-memory task list to drive multi-step work.\n\n" +
      "- Pass the FULL list every call — writes replace, they don't append.\n" +
      `- At most ${MAX_ITEMS} items.\n` +
      "- At most ONE item may be `in_progress`; extras are auto-demoted to " +
      "`pending` (the model keeps the list, but learns the constraint).\n" +
      "- When items carry `id`, updates merge by id (same id ⇒ same slot). " +
      "When ids are absent, merge is positional by index.\n" +
      "- Use this to make progress legible: one `in_progress` at a time, " +
      "mark `completed` as you go, reprioritize by editing the list.\n" +
      "- The list is in-memory per session; it does not persist across " +
      "process restarts (that's step-26 checkpoints' job).",
    examples: [
      `todo_write({ todos: [
  { content: "Read step-11 spec", status: "completed", priority: "high" },
  { content: "Implement todoWrite", status: "in_progress", priority: "high" },
  { content: "Write smoke test", status: "pending", priority: "medium" },
] })`,
      `todo_write({ todos: [ { id: "t2", content: "...", status: "completed", priority: "high" } ] })
  // merges by id — only t2 is touched, other items stay as-is`,
    ],
  },

  fullTriggers: [
    /\b(todo|todos|task\s*list|checklist|to-?do|plan\s+steps|next\s+steps|track\s+progress)\b/i,
    /(待办|清单|任务列表|进度|下一步|计划步骤|做哪些|要做)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    const n = args?.todos?.length ?? 0;
    const inFlight = args?.todos?.filter((t) => t.status === "in_progress").length ?? 0;
    const done = args?.todos?.filter((t) => t.status === "completed").length ?? 0;
    return `Todo list (${done}/${n} done, ${inFlight} active)`;
  },

  // Bookkeeping only; no filesystem / network / destructive effect.
  checkPermissions(): PermissionPreflight {
    return { outcome: "allow" };
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    const { list, sessionBacked } = storeFor(ctx);
    const beforeCount = list.length;
    const beforeInFlight = list.filter((t) => t.status === "in_progress").length;

    const merged = mergeTodos(list, args.todos);
    const { demoted } = enforceSingleInFlight(merged);

    // Commit.
    list.length = 0;
    list.push(...merged);

    const inFlight = merged.filter((t) => t.status === "in_progress").length;
    const completed = merged.filter((t) => t.status === "completed").length;
    const pending = merged.filter((t) => t.status === "pending").length;

    // The agent-loop wrapper emits the standard `tool.call` event; the rich
    // before/after counts ride along on `structuredOutput` for the step-22
    // TodoPanel + telemetry consumers that read the JSONL tail. We do NOT add
    // a new telemetry event type — the union is frozen at step-03 and the
    // established pattern (step-08/09/10) reuses `tool.call`.
    if (demoted > 0) {
      logger.warn("todo_write: demoted extra in_progress items to pending", {
        demoted,
        beforeInFlight,
        after: inFlight,
      });
    }

    // Model-facing content: a compact render of the new list so the model can
    // verify the write landed (and see the auto-demotion if it happened).
    const lines: string[] = [];
    if (demoted > 0) {
      lines.push(
        `Note: ${demoted} extra in_progress item(s) demoted to pending ` +
          `(only one in_progress allowed at a time).`,
      );
    }
    if (merged.length === 0) {
      lines.push("Todo list cleared.");
    } else {
      lines.push(`Todo list updated (${merged.length} items):`);
      for (const t of merged) {
        const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
        const pri = t.priority === "high" ? "!" : t.priority === "low" ? "." : " ";
        const idTag = t.id ? ` ${t.id}` : "";
        lines.push(`  ${mark} ${pri}${t.content}${idTag}`);
      }
    }
    const content = lines.join("\n");

    return {
      ok: true,
      content,
      structuredOutput: {
        kind: "todo_list",
        items: merged,
        counts: {
          before: beforeCount,
          total: merged.length,
          inProgress: inFlight,
          completed,
          pending,
        },
        demoted,
        sessionBacked,
      },
      meta: { durMs: Date.now() - t0 },
    };
  },
};

// Convenience: read the current list for a given context (used by the UI
// panel in step-22; exported now so the contract is visible).
export function readTodoList(ctx?: ToolContext): TodoItem[] {
  return storeFor(ctx).list.slice();
}
