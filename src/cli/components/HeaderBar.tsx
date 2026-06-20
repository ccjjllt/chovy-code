import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../../config/index.js";

/**
 * Snapshot of the runtime budget shown in the header. Filled in piece by
 * piece by later steps:
 *   - costUSD                   ← step-16 (costTracker)
 *   - ctxUsedTokens / ctxTotal  ← step-27 (context monitor)
 *   - pressureLevel             ← step-27 (color hint when above soft/hard)
 * Until then, callers can safely pass zeros — the header just renders 0%/$0.
 */
export interface BudgetSnapshot {
  costUSD: number;
  ctxUsedTokens: number;
  ctxTotalTokens: number;
  /** SCW pressure hint (step-27). Drives the ctx-% color: fresh=dim,
   *  soft=yellow, hard=red. Omit for the legacy dim look. */
  pressureLevel?: "fresh" | "soft" | "hard";
}

/** Optional swarm summary for the header's right side (step-22). When
 *  undefined (no sub-agents ever spawned), the header omits the chip. */
export interface SwarmSummary {
  running: number;
  done: number;
}

interface Props {
  mode: PermissionMode;
  provider: string;
  model: string;
  budget: BudgetSnapshot;
  /** step-22: live sub-agent counts. Omit to hide the `swarm: NR/ND` chip. */
  swarm?: SwarmSummary;
}

/** Mode → border color. Step-12 will share these with the permission engine. */
const MODE_COLORS: Record<PermissionMode, string> = {
  default: "cyan",
  plan: "yellow",
  acceptEdits: "green",
  auto: "magenta",
  bypassPermissions: "red",
};

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "default",
  plan: "plan",
  acceptEdits: "accept-edits",
  auto: "auto",
  bypassPermissions: "bypass!",
};

/** SCW pressure → ctx label color (step-27). */
const PRESSURE_COLOR: Record<NonNullable<BudgetSnapshot["pressureLevel"]>, string | undefined> = {
  fresh: undefined, // dim default
  soft: "yellow",
  hard: "red",
};

/**
 * Top-of-screen status bar: shows the current permission mode (color-coded),
 * the active provider/model, and a budget summary. Everything else in the
 * REPL flows beneath this.
 */
export function HeaderBar({ mode, provider, model, budget, swarm }: Props): React.ReactElement {
  const ratio = budget.ctxTotalTokens > 0
    ? Math.min(100, Math.round((budget.ctxUsedTokens / budget.ctxTotalTokens) * 100))
    : 0;
  const cost = budget.costUSD.toFixed(4);
  const color = MODE_COLORS[mode];
  const swarmChip = swarm
    ? `  swarm: ${swarm.running}R/${swarm.done}D`
    : "";

  // SCW: when above soft, paint the `ctx NN%` chip yellow/red so users see
  // the warning without checking the system prompt.
  const pressureColor = budget.pressureLevel
    ? PRESSURE_COLOR[budget.pressureLevel]
    : undefined;
  const ctxBold = budget.pressureLevel === "hard";
  const tail = `  $${cost}${swarmChip}`;

  const usedK = (budget.ctxUsedTokens / 1000).toFixed(1);
  const totalK = Math.round(budget.ctxTotalTokens / 1000);
  const ctxLabel = `ctx ${usedK}k / ${totalK}k (${ratio}%)`;

  return (
    <Box
      justifyContent="space-between"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      <Box>
        <Text color={color} bold>{`▎${MODE_LABEL[mode]}`}</Text>
        <Text dimColor>{`  ${provider}/${model}`}</Text>
      </Box>
      <Box>
        {pressureColor ? (
          <Text color={pressureColor} bold={ctxBold}>{ctxLabel}</Text>
        ) : (
          <Text dimColor>{ctxLabel}</Text>
        )}
        <Text dimColor>{tail}</Text>
      </Box>
    </Box>
  );
}
