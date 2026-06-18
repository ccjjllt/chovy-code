import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SubAgentHandle } from "../../types/index.js";
import { getSubAgentPool } from "../../agent/index.js";
import { useSwarmTick } from "../state/swarmStore.js";
import { AgentRow } from "./AgentRow.js";
import { AgentDetail } from "./AgentDetail.js";
import { HotkeyBar } from "./HotkeyBar.js";

const VISIBLE_ROWS = 8;

export interface SwarmPanelBudget {
  /** Aggregate USD spent across the swarm so far. */
  spent: number;
  /** Optional cap (from a /goal budget or dispatch budgetUSD). Undefined
   *  until step-20/23 wire a real cap; the panel just omits the `/cap`. */
  cap?: number;
}

interface Props {
  agents: SubAgentHandle[];
  budget: SwarmPanelBudget;
  /** When true, this panel's hotkeys are active (InputBox is dimmed).
   *  The REPL toggles this via Tab. When false, useInput is deactivated so
   *  typing in the InputBox isn't intercepted. */
  focused: boolean;
  /** Called when the user closes the panel via Esc (REPL may unfocus). */
  onClose?: () => void;
  /** Called when the user presses [g] — REPL toggles the goal banner. */
  onGoalToggle?: () => void;
}

/**
 * SwarmPanel — the live sub-agent progress panel (step-22).
 *
 * Renders a bordered list of up to VISIBLE_ROWS handles (running first,
 * then done), with selection + cancel + detail. Per spec §UI 布局:
 *
 *   ┌─ Swarm (3 running, 5 done) ─── budget $0.18/$0.50 ┐
 *   │ ▶ sa_a1b2 explore   ⏳ reading file foo.ts   12s  $0.02
 *   │ ...
 *   │ [↑/↓] select  [x] cancel  [Enter] details  ...
 *   └──────────────────────────────────────────────────┘
 *
 * Keyboard (active only when `focused`):
 *   ↑/↓  select row (clamped to visible window)
 *   x    cancel selected sub-agent via the pool
 *   Enter open AgentDetail overlay (panel input → detail input)
 *   g    toggle the /goal banner (REPL-owned)
 *   Esc  close detail, or signal close to REPL
 *
 * Virtualization (simplified, spec §性能): only the first VISIBLE_ROWS
 * handles render; the rest collapse into a "+ N more" row. Selection index
 * is clamped to the visible window so 100-agent stress still renders ≤9
 * rows and stays under the 50ms latency bar.
 */
export function SwarmPanel({
  agents,
  budget,
  focused,
  onClose,
  onGoalToggle,
}: Props): React.ReactElement {
  // Sort: active (queued/running/paused) first by spawnedAt, then terminal
  // by finishedAt. Stable so selection doesn't jump as agents complete.
  const sorted = useMemo(() => sortForDisplay(agents), [agents]);
  const visible = sorted.slice(0, VISIBLE_ROWS);
  const hidden = Math.max(0, sorted.length - VISIBLE_ROWS);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Clamp selection when the visible window shrinks (e.g. agents drain).
  const clampedIdx = Math.min(selectedIdx, Math.max(0, visible.length - 1));
  const selected = visible[clampedIdx];

  const detailHandle = detailId
    ? sorted.find((a) => a.id === detailId) ?? null
    : null;

  // 1s tick so elapsed counters refresh without a bus event.
  const tick = useSwarmTick(1000);
  const now = Date.now();
  void tick;

  const cancelSelected = useCallback(async () => {
    if (!selected) return;
    // Optimistically mark; the pool flips status via the lifecycle path
    // which emits a lifecycle event → store re-renders. The 0.5s UI mark
    // acceptance is met because handle.cancel() aborts the child AC
    // synchronously and the engine's cancel-grace path settles fast.
    try {
      await getSubAgentPool().cancel(selected.id);
    } catch {
      /* swallow — UI-only; pool logs its own errors */
    }
  }, [selected]);

  // Detail-overlay hotkeys (active whenever the overlay is open, regardless
  // of panel focus — the overlay captures input until Esc).
  useInput(
    (input, key) => {
      if (!detailHandle) return;
      if (input === "c") {
        void detailHandle.cancel();
        return;
      }
      if (input === "s") {
        // step-26 will own real persistence; for now we just log a stub
        // snapshot string so the hotkey isn't a no-op. The REPL could
        // surface this via appendSystem if desired.
        try {
          // eslint-disable-next-line no-console
          console.error(
            `[chovy] snapshot stub for ${detailHandle.id} (TODO step-26): ` +
              `${detailHandle.role}/${detailHandle.status} cost=$${detailHandle.costUSD.toFixed(4)}`,
          );
        } catch {
          /* swallow */
        }
        return;
      }
      if (key.escape) {
        setDetailId(null);
        return;
      }
    },
    { isActive: detailHandle !== null },
  );

  // Panel-list hotkeys (active only when focused AND no detail overlay).
  useInput(
    (input, key) => {
      if (detailHandle) return;
      if (key.upArrow) {
        setSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((i) => Math.min(visible.length - 1, i + 1));
        return;
      }
      if (input === "x") {
        void cancelSelected();
        return;
      }
      if (key.return) {
        if (selected) setDetailId(selected.id);
        return;
      }
      if (input === "g") {
        onGoalToggle?.();
        return;
      }
      if (key.escape) {
        onClose?.();
        return;
      }
    },
    { isActive: focused && detailHandle === null },
  );

  const running = sorted.filter(isActive).length;
  const done = sorted.length - running;
  const budgetText = budget.cap
    ? `budget $${budget.spent.toFixed(3)}/$${budget.cap.toFixed(2)}`
    : `budget $${budget.spent.toFixed(3)}`;
  const title = `Swarm (${running} running, ${done} done)`;

  if (detailHandle) {
    return <AgentDetail handle={detailHandle} now={now} />;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{title}</Text>
        <Text dimColor>{budgetText}</Text>
      </Box>

      {visible.length === 0 ? (
        <Text dimColor>{"(no sub-agents)"}</Text>
      ) : (
        visible.map((h, i) => (
          <AgentRow
            key={h.id}
            handle={h}
            selected={i === clampedIdx && focused}
            now={now}
          />
        ))
      )}

      {hidden > 0 ? (
        <Text dimColor>{`+ ${hidden} more`}</Text>
      ) : null}

      <Box marginTop={1}>
        <HotkeyBar />
      </Box>
    </Box>
  );
}

function isActive(h: SubAgentHandle): boolean {
  return h.status === "running" || h.status === "queued" || h.status === "paused";
}

/** Active handles first (oldest spawned first), then terminal (most-recently
 *  finished first so the user sees fresh results at the top of the done
 *  block). Stable sort keeps selection from flickering. */
function sortForDisplay(agents: ReadonlyArray<SubAgentHandle>): SubAgentHandle[] {
  const active = agents.filter(isActive).sort((a, b) => a.spawnedAt - b.spawnedAt);
  const terminal = agents
    .filter((a) => !isActive(a))
    .sort((a, b) => (b.finishedAt ?? b.spawnedAt) - (a.finishedAt ?? a.spawnedAt));
  return [...active, ...terminal];
}
