import { DEFAULT_BINDINGS } from "./defaults.js";
import type { KeyBinding } from "./defaults.js";
import { loadConfig } from "../config/index.js";
import { ChovyError } from "../types/errors.js";

export type { KeyBinding };
export { DEFAULT_BINDINGS };
export * from "./parse.js";
export * from "./useKeybinding.js";
export * from "./persist.js";
export * from "./conflict.js";

export function getBinding(id: string): string {
  const config = loadConfig();
  const override = config.keybindings?.[id];
  if (override !== undefined && override !== null) {
    return override;
  }

  const def = DEFAULT_BINDINGS.find((b) => b.id === id);
  if (!def) {
    throw new ChovyError("INTERNAL", `Unknown keybinding id: ${id}`);
  }
  return def.defaultKey;
}

export function registerBinding(b: KeyBinding): void {
  const existing = DEFAULT_BINDINGS.find((x) => x.id === b.id);
  if (existing) {
    Object.assign(existing, b);
  } else {
    DEFAULT_BINDINGS.push(b);
  }
}

export function listBindings(): KeyBinding[] {
  return [...DEFAULT_BINDINGS];
}
