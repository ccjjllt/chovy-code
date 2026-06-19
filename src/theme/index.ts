import type { Theme } from "./tokens.js";
import { ChovyDefault, BUILT_INS } from "./tokens.js";
import { resolveTheme } from "./resolve.js";
import { persistTheme } from "./persist.js";
import { loadConfig, saveConfigPatch } from "../config/index.js";
import { emitTelemetry } from "../telemetry/index.js";

let _current: Theme = ChovyDefault;
const _listeners = new Set<(t: Theme) => void>();

// Initialize based on config synchronously
try {
  const config = loadConfig();
  if (config.theme?.name) {
    _current = resolveTheme(config.theme.name, config.theme.custom);
  }
} catch {
  // Ignore config load error during startup
}

export function getTheme(): Theme {
  return _current;
}

export function setTheme(name: string): void {
  const config = loadConfig();
  const next = resolveTheme(name, config.theme?.custom);
  _current = next;
  for (const l of _listeners) {
    try {
      l(next);
    } catch {}
  }
  persistTheme(name);
  emitTelemetry({ type: "tui.theme.change", name });
}

export function resetTheme(): void {
  const next = resolveTheme("ChovyDefault", null);
  _current = next;
  for (const l of _listeners) {
    try {
      l(next);
    } catch {}
  }
  saveConfigPatch({ theme: { name: "ChovyDefault", custom: undefined } } as any);
  emitTelemetry({ type: "tui.theme.change", name: "ChovyDefault" });
}

export function setCustomTheme(custom: Record<string, string>): void {
  const config = loadConfig();
  const name = config.theme?.name ?? "ChovyDefault";
  const mergedCustom = { ...(config.theme?.custom ?? {}), ...custom };
  
  const next = resolveTheme(name, mergedCustom);
  _current = next;
  for (const l of _listeners) {
    try {
      l(next);
    } catch {}
  }
  saveConfigPatch({ theme: { name, custom: mergedCustom } });
  emitTelemetry({ type: "tui.theme.change", name });
}

export function createTheme(name: string, custom: Record<string, string>): void {
  const next = resolveTheme(name, custom);
  _current = next;
  for (const l of _listeners) {
    try {
      l(next);
    } catch {}
  }
  saveConfigPatch({ theme: { name, custom } });
  emitTelemetry({ type: "tui.theme.change", name });
}

export function listThemes(): Theme[] {
  return BUILT_INS;
}

export function onThemeChange(fn: (t: Theme) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

import { useSyncExternalStore } from "react";

export function useTheme(): Theme {
  return useSyncExternalStore(onThemeChange, getTheme);
}

export type { Theme };
