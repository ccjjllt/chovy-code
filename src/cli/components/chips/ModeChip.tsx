
import { useTheme } from "../../../theme/index.js";
import { t } from "../../../i18n/index.js";
import type { PermissionMode } from "../../../config/index.js";
import { Chip } from "./Chip.js";

const MODE_KEY: Record<PermissionMode, string> = {
  default: "header.mode.default",
  plan: "header.mode.plan",
  acceptEdits: "header.mode.acceptEdits",
  auto: "header.mode.auto",
  bypassPermissions: "header.mode.bypass",
};

export function ModeChip({ mode }: { mode: PermissionMode }) {
  const theme = useTheme();
  const colors: Record<PermissionMode, string> = {
    default: theme.accent,
    plan: theme.warning,
    acceptEdits: theme.success,
    auto: theme.primary,
    bypassPermissions: theme.error,
  };
  return <Chip icon="▎" label={t(MODE_KEY[mode])} color={colors[mode]} bold />;
}
