import type { CompanionState } from "./types.js";

export type CompanionEvent =
  | { type: "state"; state: CompanionState; reason?: string }
  | { type: "bubble"; text: string }
  | { type: "pet" }
  | { type: "skin"; name: string };

export type CompanionListener = (e: CompanionEvent) => void;

const listeners = new Set<CompanionListener>();

export function onCompanionEvent(cb: CompanionListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function emitCompanionEvent(e: CompanionEvent): void {
  if (listeners.size === 0) return;
  for (const cb of [...listeners]) {
    try {
      cb(e);
    } catch {
      // ignore
    }
  }
}

export const companionBus = {
  on: onCompanionEvent,
  emit: emitCompanionEvent,
};

export function _companionBusListenerCount(): number {
  return listeners.size;
}

export function _resetCompanionBusForTesting(): void {
  listeners.clear();
}
