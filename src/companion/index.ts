import { useState, useEffect } from "react";
import { getCompanionStateMachine } from "./stateMachine.js";
import { companionBus } from "./stateBus.js";

export * from "./types.js";
export * from "./cache.js";
export * from "./player.js";
export * from "./ascii-fallback.js";
export * from "./stateBus.js";
export * from "./stateMachine.js";
export * from "./skin.js";
export * from "./CompanionHost.js";

export interface CompanionHandle {
  setState(s: import("./types.js").CompanionState): void;
  pet(): void;
  mute(b: boolean): void;
  skin(name: string): void;
  dispose(): void;
}

let companionMuted = false;
let userSkin = "default";
const muteListeners = new Set<(v: boolean) => void>();
const skinListeners = new Set<(v: string) => void>();

export function setUserCompanionMuted(b: boolean) {
  companionMuted = b;
  muteListeners.forEach(cb => cb(b));
}
export function useCompanionMuted() {
  const [m, setM] = useState(companionMuted);
  useEffect(() => {
    muteListeners.add(setM);
    return () => { muteListeners.delete(setM); };
  }, []);
  return [m, setUserCompanionMuted] as const;
}

export function setUserSkin(n: string) {
  userSkin = n;
  skinListeners.forEach(cb => cb(n));
}
export function useUserSkin() {
  const [s, setS] = useState(userSkin);
  useEffect(() => {
    skinListeners.add(setS);
    return () => { skinListeners.delete(setS); };
  }, []);
  return [s, setUserSkin] as const;
}

export function mountCompanion(opts: { cwd: string; muted?: boolean }): CompanionHandle {
  const sm = getCompanionStateMachine();
  if (opts.muted) setUserCompanionMuted(true);
  return {
    setState: (s) => sm.setState(s),
    pet: () => companionBus.emit({ type: "pet" }),
    mute: (b) => setUserCompanionMuted(b),
    skin: (n) => setUserSkin(n),
    dispose: () => sm.dispose(),
  };
}

export function companionReservedColumns(cols: number, speaking: boolean, skinCols: number = 20): number {
  if (companionMuted || process.env["CHOVY_NO_COMPANION"] === "1") return 0;
  if (cols < 60) return 0;
  const gifCols = cols < 100 ? 16 : skinCols;
  const bubble = speaking ? 35 : 0; // 34 width + 1 marginRight
  return gifCols + bubble + 2; // paddingX=1
}
