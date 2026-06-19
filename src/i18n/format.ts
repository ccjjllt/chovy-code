import { loadConfig } from "../config/index.js";
import { getLocale } from "./index.js";

export function formatCost(usd: number): string {
  if (!loadConfig().i18n?.costInCNY) return `$${usd.toFixed(4)}`;
  return getLocale() === "zh" ? `￥${(usd * 7.2).toFixed(4)}` : `$${usd.toFixed(4)}`;
}
