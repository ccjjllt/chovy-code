import { useState, useEffect } from "react";
import { getCompanionStateMachine } from "./stateMachine.js";
import { companionBus } from "./stateBus.js";

import { recordEvent } from "../screens/onboarding.js";
import { version } from "../version.js";

export * from "./types.js";
export * from "./cache.js";
export * from "./player.js";
export * from "./ascii-fallback.js";
export * from "./stateBus.js";
export * from "./stateMachine.js";
export * from "./skin.js";
export * from "./CompanionHost.js";
export * from "./prefs.js";

export interface CompanionHandle {
  setState(s: import("./types.js").CompanionState): void;
  pet(): void;
  mute(b: boolean): void;
  skin(name: string): void;
  dispose(): void;
}

import { getPrefs, prefsEvents, setMuted, setSkin } from "./prefs.js";

export function useCompanionPrefs() {
  const [prefs, setPrefs] = useState(() => getPrefs());
  useEffect(() => {
    const handler = () => setPrefs(getPrefs());
    prefsEvents.on("change", handler);
    return () => { prefsEvents.off("change", handler); };
  }, []);
  return prefs;
}

export function setUserCompanionMuted(b: boolean) {
  setMuted(b);
}
export function useCompanionMuted() {
  const prefs = useCompanionPrefs();
  return [prefs.muted, setUserCompanionMuted] as const;
}

export function setUserSkin(n: string) {
  setSkin(n);
}
export function useUserSkin() {
  const prefs = useCompanionPrefs();
  return [prefs.skin, setUserSkin] as const;
}

export function mountCompanion(opts: { cwd: string; muted?: boolean }): CompanionHandle {
  const sm = getCompanionStateMachine();
  if (opts.muted) setUserCompanionMuted(true);
  return {
    setState: (s) => sm.setState(s),
    pet: () => {
      recordEvent("buddy", version);
      companionBus.emit({ type: "pet" });
    },
    mute: (b) => setUserCompanionMuted(b),
    skin: (n) => setUserSkin(n),
    dispose: () => sm.dispose(),
  };
}

export function companionReservedColumns(cols: number, speaking: boolean, skinCols: number = 20): number {
  const prefs = getPrefs();
  if (prefs.muted || !prefs.visible || process.env["CHOVY_NO_COMPANION"] === "1") return 0;
  if (cols < 60) return 0;
  
  let gifCols = 20;
  if (prefs.size === "compact") gifCols = 16;
  else if (prefs.size === "small") gifCols = 12;
  else gifCols = cols < 100 ? 16 : skinCols;

  const bubble = speaking ? 35 : 0; // 34 width + 1 marginRight
  return gifCols + bubble + 2; // paddingX=1
}
