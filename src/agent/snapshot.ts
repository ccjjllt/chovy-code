/**
 * Parent → child context snapshot (step-18).
 *
 * The runtime captures the parent's recent message tail (and, after
 * step-25/26 land, MEMORY/checkpoint summaries) into a `ParentContextSnapshot`.
 * The snapshot rides the sub-agent's Layer-2 (`agent`) system prompt slot
 * via `formatSnapshotXml(...)` so the child sees what the parent saw without
 * the parent's full rolling context.
 *
 * Step-18 fills only the *known* fields:
 *   - `recentMessages` (last K = 6 by default)
 *   - `parentRole`, `parentObjective`
 * The other fields (`memorySummary`, `activeTaskProgress`, `decisions`)
 * are reserved for step-25/26 and emitted as empty/undefined here.
 *
 * Naming: `types/context.ts` already owns `ContextSnapshot` for SCW
 * (step-27/28), so step-18's analogue is `ParentContextSnapshot` — see
 * `docs/complete/step-18-acceptance.md` for the rename rationale.
 */
import type {
  AgentRole,
  ChatMessage,
  ParentContextSnapshot,
} from "../types/index.js";

export interface BuildSnapshotOptions {
  /** Number of trailing parent messages to capture. Default 6. */
  k?: number;
  /** Current `/goal` objective (when running under the goal loop). */
  objective?: string;
}

export const DEFAULT_RECENT_MESSAGE_LIMIT = 6;

/**
 * Capture the parent's tail messages and surrounding context. Pure: the
 * caller is responsible for any further mutation / serialization.
 */
export function buildParentSnapshot(
  parentMessages: ReadonlyArray<ChatMessage>,
  parentRole: AgentRole,
  opts: BuildSnapshotOptions = {},
): ParentContextSnapshot {
  const k = opts.k ?? DEFAULT_RECENT_MESSAGE_LIMIT;
  // We slice a defensive copy so mutation on the parent's transcript can't
  // leak into the child (and vice versa). Slicing 0 is well-defined.
  const recent = parentMessages.slice(Math.max(0, parentMessages.length - k));
  return {
    recentMessages: recent.slice(),
    memorySummary: "",                  // TODO step-25 (TMT injection)
    activeTaskProgress: undefined,      // TODO step-26 (checkpoint writer)
    decisions: [],                      // TODO step-26 (checkpoint writer)
    parentRole,
    parentObjective: opts.objective,
  };
}

/**
 * Render a snapshot as an XML envelope suitable for prepending to the
 * sub-agent's Layer-2 `agent` system prompt. Empty fields are omitted to
 * keep the prefix small (this matters at scale — the snapshot rides
 * every sub-agent spawn).
 *
 * The shape is deliberately flat (no nesting beyond the message list) so
 * downstream models — across providers — parse it consistently. We do not
 * attempt JSON / YAML; the envelope is human-readable for `chovy log tail`.
 */
export function formatSnapshotXml(s: ParentContextSnapshot): string {
  const parts: string[] = ["<parent-session-snapshot>"];
  parts.push(`  <parent-role>${escapeXml(s.parentRole)}</parent-role>`);
  if (s.parentObjective) {
    parts.push(
      `  <parent-objective>${escapeXml(s.parentObjective)}</parent-objective>`,
    );
  }
  if (s.memorySummary) {
    parts.push(
      `  <memory-summary>\n${indent(escapeXml(s.memorySummary), 4)}\n  </memory-summary>`,
    );
  }
  if (s.activeTaskProgress) {
    parts.push(
      `  <active-task-progress>\n${indent(escapeXml(s.activeTaskProgress), 4)}\n  </active-task-progress>`,
    );
  }
  if (s.decisions.length > 0) {
    parts.push("  <decisions>");
    for (const d of s.decisions) {
      parts.push(`    <decision>${escapeXml(d)}</decision>`);
    }
    parts.push("  </decisions>");
  }
  if (s.recentMessages.length > 0) {
    parts.push("  <recent-messages>");
    for (const m of s.recentMessages) {
      // We intentionally drop tool messages and reasoning blobs — the
      // parent's tool call/response cycle isn't replayable in the child,
      // and reasoning text is provider-specific.
      if (m.role === "tool") continue;
      const body = (m.content ?? "").slice(0, 4_000); // cap per-message
      parts.push(
        `    <msg role="${escapeXml(m.role)}">${escapeXml(body)}</msg>`,
      );
    }
    parts.push("  </recent-messages>");
  }
  parts.push("</parent-session-snapshot>");
  return parts.join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}
