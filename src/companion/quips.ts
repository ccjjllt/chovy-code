import type { CompanionState } from "./types.js";

const QUIPS: Record<CompanionState, string[]> = {
  idle: ["companion.bubble.idle", "companion.bubble.idle.alt1"],
  work: ["companion.bubble.work", "companion.bubble.work.alt1"],
  think: ["companion.bubble.think"],
  done: ["companion.bubble.done.success1", "companion.bubble.done.success2", "companion.bubble.done.success3"],
  error: ["companion.bubble.error", "companion.bubble.error.alt1"],
};

export function pickQuip(state: CompanionState): string {
  const arr = QUIPS[state];
  return arr![Math.floor(Math.random() * arr!.length)]!;
}
