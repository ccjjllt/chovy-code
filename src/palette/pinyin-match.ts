import { getPinyinInitials } from "../i18n/pinyin-initials.js";

export function toInitials(s: string): string {
  return getPinyinInitials(s).toLowerCase();
}
