
import { useTheme } from "../../../theme/index.js";
import { t } from "../../../i18n/index.js";
import { Chip } from "./Chip.js";
import type { GoalChipSnapshot } from "../HeaderBar.js";

export function GoalChip({ snap }: { snap: GoalChipSnapshot }) {
  const theme = useTheme();
  const used = snap.budgetUsed.toFixed(2);
  const cap = snap.budgetCap !== undefined ? `/$${snap.budgetCap.toFixed(2)}` : "";
  const dot = snap.status === "paused" ? "⏸" : "▶";
  return (
    <Chip
      icon={dot}
      label={t("header.goal", { rounds: snap.rounds, used, cap })}
      color={snap.status === "paused" ? theme.warning : theme.accent}
      bold
    />
  );
}
