import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../../config/index.js";

/**
 * Snapshot of the runtime budget shown in the header. Filled in piece by
 * piece by later steps:
 *   - costUSD                   ← step-16 (costTracker)
 *   - ctxUsedTokens / ctxTotal  ← step-27 (context monitor)
 * Until then, callers can safely pass zeros — the header just renders 0%/$0.
 */
export interface BudgetSnapshot {
  costUSD: number;
  ctxUsedTokens: number;
  ctxTotalTokens: number;
}

interface Props {
  mode: PermissionMode;
  provider: string;
  model: string;
  budget: BudgetSnapshot;
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

/**
 * Top-of-screen status bar: shows the current permission mode (color-coded),
 * the active provider/model, and a budget summary. Everything else in the
 * REPL flows beneath this.
 */
export function HeaderBar({ mode, provider, model, budget }: Props): React.ReactElement {
  const ratio = budget.ctxTotalTokens > 0
    ? Math.min(100, Math.round((budget.ctxUsedTokens / budget.ctxTotalTokens) * 100))
    : 0;
  const cost = budget.costUSD.toFixed(4);
  const color = MODE_COLORS[mode];

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
        <Text dimColor>{`ctx ${ratio}%  $${cost}`}</Text>
      </Box>
    </Box>
  );
}
