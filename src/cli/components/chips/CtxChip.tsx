
import { useTheme } from "../../../theme/index.js";
import { t } from "../../../i18n/index.js";
import { Chip } from "./Chip.js";

export function CtxChip({ used, total, level }: { used: number; total: number; level?: "fresh" | "soft" | "hard" }) {
  const theme = useTheme();
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const color = level === "hard" ? theme.error : level === "soft" ? theme.warning : undefined;
  return <Chip label={t("header.ctx", { pct })} color={color ?? theme.muted} dim={!color} bold={level === "hard"} />;
}
