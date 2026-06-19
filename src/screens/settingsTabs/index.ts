import type { SettingsCategory } from "../state.js";

export const CATEGORY_LIST: SettingsCategory[] = [
  "general",
  "provider",
  "model",
  "theme",
  "language",
  "keybind",
  "advanced",
];

export interface SettingsField {
  id: string;
  label: string;
  category: SettingsCategory;
  section?: string;
  description?: string;
  type: "text" | "select" | "toggle" | "hotkey" | "secret" | "color" | "readonly";
  read(): string;
  write(v: string): Promise<void>;
  options?: { value: string; label: string }[] | (() => { value: string; label: string }[]);
  validate?(v: string): string | null;
  restartRequired?: boolean;
}

export function listSettingsFields(): SettingsField[] {
  // Step-49+ registration logic goes here
  return [];
}

export function registerSettingsField(_f: SettingsField): void {
  // Step-49+ registration logic goes here
}
