import { loadConfig, saveConfigPatch } from "../config/index.js";
import type { ChovyConfig } from "../config/index.js";
import { EventEmitter } from "node:events";

export const prefsEvents = new EventEmitter();

export type CompanionPrefs = ChovyConfig["companion"];

export function getPrefs(): CompanionPrefs {
  return loadConfig().companion;
}

export function setMuted(muted: boolean): void {
  saveConfigPatch({ companion: { muted } });
  prefsEvents.emit("change");
}

export function setVisible(visible: boolean): void {
  saveConfigPatch({ companion: { visible } });
  prefsEvents.emit("change");
}

export function setSkin(skin: string): void {
  saveConfigPatch({ companion: { skin } });
  prefsEvents.emit("change");
}

export function setSize(size: CompanionPrefs["size"]): void {
  saveConfigPatch({ companion: { size } });
  prefsEvents.emit("change");
}

export function incPetCount(): number {
  const current = getPrefs().petCount;
  const next = current + 1;
  saveConfigPatch({ companion: { petCount: next } });
  return next;
}
