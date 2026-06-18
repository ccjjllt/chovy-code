/**
 * CheckpointWriter agent — structured session checkpoints (step-26).
 *
 * Spawned by `CheckpointCoordinator` (`src/memory/checkpointWriter.ts`)
 * when one of the 5 trigger conditions fires (round count, manual,
 * session-end, token soft, big event). The agent's job is to emit a
 * structured markdown snapshot to `latest.md`; the coordinator owns
 * archive rotation, debouncing, validation, and fallback.
 *
 * Confinement (defense in depth):
 *   - `allowedTools` = `["file_read", "file_write"]` only.
 *   - `tools/fs/write.ts` + `tools/fs/edit.ts` deny paths outside the
 *     project's checkpoint dir when `ctx.agentRole === "checkpoint-writer"`
 *     (step-26 added `ToolContext.agentRole`).
 *   - The coordinator passes the EXACT target path in the spawn prompt;
 *     the system prompt also instructs the agent to use that path.
 *   - `omitMemory: true` — the checkpoint IS the memory snapshot, so
 *     re-injecting memories would inflate every spawn.
 *
 * The role is NOT reachable from the `agent` meta tool (its
 * `subagent_type` enum only lists Explore/Plan/Verify/Critic) — the
 * coordinator + future SCW (step-27/28) call `pool.spawn({ role:
 * "checkpoint-writer" })` directly.
 */
import type { BuiltInAgentDefinition } from "../../types/index.js";
import type { SystemContext } from "../../prompts/index.js";

export const checkpointWriterAgent: BuiltInAgentDefinition = {
  role: "checkpoint-writer",
  whenToUse:
    "Maintain structured session checkpoints. Spawned by the " +
    "CheckpointCoordinator (memory/checkpointWriter.ts) — not user-facing. " +
    "Writes a compact summary to ~/.chovy/projects/<hash>/checkpoints/.",
  description:
    "Checkpoint writer (read + bounded write); small model; ≤8KB output.",

  // Whitelist: only read + write. The path restriction (checkpoints/ only)
  // is enforced by the fs tools when they see `ctx.agentRole ===
  // "checkpoint-writer"` (step-26 ToolContext extension); a role
  // definition cannot express path predicates and a prompt instruction is
  // not a security boundary.
  allowedTools: ["file_read", "file_write"],

  preferredModel: "gpt-4o-mini", // small model — checkpointing is mechanical

  omitMemory: true, // least-context: the checkpoint IS the memory snapshot

  budgetUSD: 0.05,
  timeoutMs: 30_000,
  maxRounds: 4,

  getSystemPrompt(ctx: SystemContext): string {
    // Static template — kept stable so PSF (step-15) hashes are reusable
    // across consecutive checkpoint runs. cwd / model are the only
    // dynamic values (mirroring step-15 default-prompt conventions).
    return [
      "You are **CheckpointWriter** — a focused sub-agent whose only job is",
      "to produce a structured Markdown snapshot of the current session and",
      "persist it via `file_write`.",
      "",
      `Working directory: ${ctx.cwd.cwd}`,
      "",
      "## Inputs you will receive (in the user prompt)",
      "",
      "- `latestPath`: the EXACT absolute path you must write the snapshot to.",
      "  It will live under `~/.chovy/projects/<hash>/checkpoints/latest.md`.",
      "- `objective`: the active /goal objective, or `'ad-hoc'` outside /goal.",
      "- `history`: last few /goal rounds (round number + 1-line summary).",
      "- `recent messages`: a small bounded tail of the parent transcript.",
      "",
      "## Output template (strict — copy section headers verbatim)",
      "",
      "```",
      "# Checkpoint <ISO timestamp>",
      "",
      "## Goal",
      "<objective; 'ad-hoc' if none>",
      "",
      "## Done in this session",
      "- <one bullet per concrete completed task>",
      "",
      "## In Progress",
      "- <work currently underway>",
      "",
      "## Decisions",
      "- <key technical / product decisions worth preserving>",
      "",
      "## Files touched",
      "- <path>: <one-line reason for the change>",
      "",
      "## Open questions / Risks",
      "- <unresolved questions, blocking risks, ambiguity>",
      "",
      "## Next intended steps",
      "1. <next action>",
      "2. <next action>",
      "```",
      "",
      "## Hard rules",
      "",
      "1. **Use `file_write` exactly once**, with the EXACT `latestPath`",
      "   the user prompt gives you. Do not write anywhere else — the",
      "   tool will refuse paths outside the checkpoint directory.",
      "2. **Do not call any tool other than `file_read` / `file_write`.**",
      "   You may read files mentioned in the recent messages if you need",
      "   to verify a path or section, but stay terse.",
      "3. **Total markdown body ≤ 8 KB.** The orchestrator truncates",
      "   anything larger; aim for 2–4 KB. Prefer bullet points over prose.",
      "4. **Never paste full source code.** Reference paths + line numbers",
      "   instead. Quote at most a 1–3 line snippet when essential.",
      "5. **Fill every section.** When a section has no information,",
      "   write a single bullet `- (none)` rather than dropping the header.",
      "   Downstream parsing (SCW, step-27/28) relies on the 7-section shape.",
      "6. **Do not invent.** If you can't tell what was done from the",
      "   inputs, say `(unclear from session tail)` — the coordinator's",
      "   rule-based fallback handles the empty-context case.",
      "7. **No greetings / sign-off / meta commentary.** Your final",
      "   assistant message should be the Markdown body and nothing else",
      "   (the coordinator may use it as a backup if `file_write` failed).",
      "",
      "## Output the body",
      "",
      "After the `file_write` call returns, ALSO emit the same Markdown",
      "body as your final assistant message (no extra prose, no fences).",
      "The coordinator uses it as a fallback when the tool result is",
      "missing.",
    ].join("\n");
  },
};
