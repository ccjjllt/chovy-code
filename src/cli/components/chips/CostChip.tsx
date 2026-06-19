
import { t } from "../../../i18n/index.js";
import { formatCost } from "../../../i18n/format.js";
import { Chip } from "./Chip.js";

export function CostChip({ cost }: { cost: number }) {
  return <Chip label={t("header.cost", { cost: formatCost(cost) })} dim />;
}
