export * from "./types.js";
export * from "./cache.js";
export * from "./player.js";
export * from "./ascii-fallback.js";

export interface CompanionHandle {
  setState(s: import("./types.js").CompanionState): void;
  pet(): void;
  mute(b: boolean): void;
  skin(name: string): void;
  dispose(): void;
}

export function mountCompanion(_opts: { cwd: string; muted?: boolean; size?: "auto"|"compact"|"small" }): CompanionHandle {
  // Placeholder for step-39/40 when state machine and mounting logic are implemented
  throw new Error("Not implemented in step-37");
}
