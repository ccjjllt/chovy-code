import React from "react";
import { Box, Text, useInput } from "ink";
import type { GoalState } from "../../types/index.js";

/**
 * GoalPanel — Ink UI panel for the active /goal (step-23).
 *
 * Renders the current round / budget / status / last summary; handles
 * keyboard hotkeys when focused (`p` pause, `c` cancel). Hidden whenever
 * `goal` is null (no active goal). Mounting is gated on
 * `CHOVY_NO_SWARM_PANEL=1` by the caller (REPL) so Windows ConHost users
 * have a single env knob to disable both panels.
 *
 * Mirrors `docs/step-23 §UI`:
 *
 * ```
 * ┌─ /goal: <objective> ────────────────────────────────────┐
 * │ round 4/25     budget $0.42/$5.00     status: active    │
 * │ rubric: bun typecheck 退出码 = 0                          │
 * │ last:   修复了 src/.../agent.ts 中的类型错误（剩 3 处）   │
 * │ [p] pause  [c] cancel  [Enter] details                  │
 * └─────────────────────────────────────────────────────────┘
 * ```
 */

export interface GoalPanelProps {
  goal: GoalState;
  /** True iff this panel currently owns keyboard input. */
  focused: boolean;
  /** Hotkey: `p` ⇒ pause. */
  onPause(): void;
  /** Hotkey: `c` ⇒ cancel/clear. */
  onCancel(): void;
  /** Hotkey: Enter ⇒ open details overlay (parent provides the toggle). */
  onToggleDetails?(): void;
}

export function GoalPanel({
  goal,
  focused,
  onPause,
  onCancel,
  onToggleDetails,
}: GoalPanelProps): React.ReactElement {
  // Hotkeys only active when focused — otherwise the InputBox / SwarmPanel
  // own the keyboard. Tab switching lives in the REPL component.
  useInput(
    (input, key) => {
      if (input === "p") {
        onPause();
        return;
      }
      if (input === "c") {
        onCancel();
        return;
      }
      if (key.return && onToggleDetails) {
        onToggleDetails();
        return;
      }
    },
    { isActive: focused },
  );

  const last = goal.history[goal.history.length - 1];
  const statusColor = goal.status === "active"
    ? "cyan"
    : goal.status === "achieved"
      ? "green"
      : goal.status === "paused"
        ? "yellow"
        : goal.status === "failed"
          ? "red"
          : "gray";

  const headerColor = focused ? "magenta" : "blue";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={headerColor}
      paddingX={1}
    >
      <Box>
        <Text color={headerColor} bold>{`/goal `}</Text>
        <Text>{truncate(goal.objective, 60)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {`round ${goal.rounds}/${goal.maxRounds}     `}
          {`budget $${goal.totalCostUSD.toFixed(2)}/$${goal.budgetUSD.toFixed(2)}     `}
        </Text>
        <Text color={statusColor}>{`status: ${goal.status}`}</Text>
      </Box>
      <Box>
        <Text dimColor>{`rubric: ${describeConvergence(goal)}`}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {`last:   ${last ? truncate(last.summary, 70) + (last.converged ? " ✓" : "") : "(no rounds yet)"}`}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{`[p] pause  [c] cancel  [Enter] details`}</Text>
        {focused ? (
          <Text color="magenta" dimColor>{"  ◀ focused"}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function describeConvergence(goal: GoalState): string {
  const c = goal.convergence;
  switch (c.mode) {
    case "command":
      return `\`${c.cmd}\` exit=${c.expectedExitCode ?? 0}`;
    case "rubric":
      return truncate(c.rubric, 80);
    case "hybrid":
      return `\`${c.cmd}\` ∧ ${truncate(c.rubric, 50)}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
