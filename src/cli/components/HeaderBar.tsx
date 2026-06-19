import React, { useMemo } from "react";
import { Box } from "ink";
import type { PermissionMode } from "../../config/index.js";
import { useTheme } from "../../theme/index.js";
import { useTerminalCaps, type TerminalCaps } from "../../tui/capabilities.js";
import { stringWidth } from "../../tui/stringWidth.js";
import { t } from "../../i18n/index.js";
import { formatCost } from "../../i18n/format.js";

import {
  ModeChip,
  ProviderModelChip,
  CtxChip,
  CostChip,
  SwarmChip,
  GoalChip,
} from "./chips/index.js";

export interface BudgetSnapshot {
  costUSD: number;
  ctxUsedTokens: number;
  ctxTotalTokens: number;
  pressureLevel?: "fresh" | "soft" | "hard";
}

export interface SwarmSummary {
  running: number;
  done: number;
}

export interface GoalChipSnapshot {
  rounds: number;
  status: "active" | "paused";
  budgetUsed: number;
  budgetCap?: number;
}

export interface Props {
  mode: PermissionMode;
  provider: string;
  model: string;
  budget: BudgetSnapshot;
  swarm?: SwarmSummary;
  goal?: GoalChipSnapshot;
}

type ChipName = "mode" | "model" | "ctx" | "cost" | "goal" | "swarm";

function estimateChipWidth(chip: ChipName, snap: Props): number {
  switch (chip) {
    case "mode":
      return stringWidth(`▎ ${t(`header.mode.${snap.mode}`)}`) + 1;
    case "model":
      return stringWidth(`${snap.provider}/${snap.model}`) + 1;
    case "ctx": {
      const ratio = snap.budget.ctxTotalTokens > 0
        ? Math.min(100, Math.round((snap.budget.ctxUsedTokens / snap.budget.ctxTotalTokens) * 100))
        : 0;
      return stringWidth(t("header.ctx", { pct: ratio })) + 1;
    }
    case "cost":
      return stringWidth(t("header.cost", { cost: formatCost(snap.budget.costUSD) })) + 1;
    case "goal": {
      if (!snap.goal) return 0;
      const used = snap.goal.budgetUsed.toFixed(2);
      const cap = snap.goal.budgetCap !== undefined ? `/$${snap.goal.budgetCap.toFixed(2)}` : "";
      return stringWidth(`▶ ${t("header.goal", { rounds: snap.goal.rounds, used, cap })}`) + 1;
    }
    case "swarm":
      if (!snap.swarm) return 0;
      return stringWidth(`swarm: ${snap.swarm.running}R/${snap.swarm.done}D`) + 1;
  }
}

function chooseChips(caps: TerminalCaps, snapshot: Props): ChipName[] {
  const all: ChipName[] = ["mode", "model", "ctx", "cost", "goal", "swarm"];
  const present = all.filter(c => {
    if (c === "goal") return !!snapshot.goal;
    if (c === "swarm") return !!snapshot.swarm;
    return true;
  });

  const widths = present.map(c => estimateChipWidth(c, snapshot));
  let total = widths.reduce((a, b) => a + b, 0);

  if (total <= caps.cols - 4) return present;

  const result = [...present];
  while (result.length > 1 && total > caps.cols - 4) {
    const dropped = result.pop()!;
    total -= estimateChipWidth(dropped, snapshot);
  }
  return result;
}

export function HeaderBar(props: Props): React.ReactElement {
  const theme = useTheme();
  const caps = useTerminalCaps();
  
  const chips = useMemo(() => chooseChips(caps, props), [caps, props]);

  const leftNames: ChipName[] = ["mode", "model"];
  const rightNames: ChipName[] = ["ctx", "cost", "goal", "swarm"];

  const leftChips = chips.filter(c => leftNames.includes(c));
  const rightChips = chips.filter(c => rightNames.includes(c));

  const renderChip = (c: ChipName) => {
    switch (c) {
      case "mode": return <ModeChip key="mode" mode={props.mode} />;
      case "model": return <ProviderModelChip key="model" provider={props.provider} model={props.model} />;
      case "ctx": return <CtxChip key="ctx" used={props.budget.ctxUsedTokens} total={props.budget.ctxTotalTokens} level={props.budget.pressureLevel} />;
      case "cost": return <CostChip key="cost" cost={props.budget.costUSD} />;
      case "goal": return props.goal ? <GoalChip key="goal" snap={props.goal} /> : null;
      case "swarm": return props.swarm ? <SwarmChip key="swarm" running={props.swarm.running} done={props.swarm.done} /> : null;
    }
  };

  const colors: Record<PermissionMode, string> = {
    default: theme.accent,
    plan: theme.warning,
    acceptEdits: theme.success,
    auto: theme.primary,
    bypassPermissions: theme.error,
  };
  const borderColor = colors[props.mode] ?? theme.primary;

  return (
    <Box justifyContent="space-between" borderStyle={theme.borderStyle} borderColor={borderColor} paddingX={1}>
      <Box>{leftChips.map(renderChip)}</Box>
      <Box>{rightChips.map(renderChip)}</Box>
    </Box>
  );
}
