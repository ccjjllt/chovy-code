import { loadConfig, saveConfigPatch } from "../config/index.js";

export function getUserBindings(): Record<string, string | null> {
  const config = loadConfig();
  return config.keybindings ?? {};
}

export function setUserBinding(id: string, key: string | null): void {
  saveConfigPatch({
    keybindings: {
      [id]: key,
    },
  });
}
