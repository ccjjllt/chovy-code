import { useSyncExternalStore } from "react";

export type FocusTarget = "input" | "palette" | "settings" | "swarm" | "goal" | "companion";

export interface FocusState {
  current: FocusTarget;
  hidden: Set<FocusTarget>;
  modality?: "palette" | "settings";
}

type Listener = () => void;

function createStore<T>(initialState: T) {
  let state = initialState;
  const listeners = new Set<Listener>();

  return {
    getState: () => state,
    setState: (fn: (prev: T) => T) => {
      state = fn(state);
      listeners.forEach((l) => l());
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const _focusStore = createStore<FocusState>({
  current: "input",
  hidden: new Set<FocusTarget>(),
  modality: undefined,
});

export function useFocusStore(): FocusState {
  return useSyncExternalStore(_focusStore.subscribe, _focusStore.getState);
}

const RING_ORDER: FocusTarget[] = ["input", "swarm", "goal", "companion", "palette", "settings"];

export function nextFocus(state: FocusState, dir: 1 | -1): FocusTarget {
  let candidates: FocusTarget[];
  if (state.modality) {
    candidates = ["input", state.modality];
  } else {
    candidates = RING_ORDER.filter(t => !state.hidden.has(t) && t !== "palette" && t !== "settings");
  }
  if (candidates.length === 0) return "input";
  const idx = candidates.indexOf(state.current);
  if (idx < 0) return candidates[0]!;
  const n = candidates.length;
  return candidates[(idx + dir + n) % n]!;
}

export function cycleFocus(dir: 1 | -1) {
  _focusStore.setState((s) => ({
    ...s,
    current: nextFocus(s, dir),
  }));
}

export function setFocus(target: FocusTarget) {
  _focusStore.setState((s) => {
    // modality 与 focus.current 不允许"unconsistent"状态
    if (s.modality && target !== "input" && target !== s.modality) {
      console.warn(`Cannot focus ${target} while modality is ${s.modality}`);
      return s;
    }
    return { ...s, current: target };
  });
}

export function setModality(modality: "palette" | "settings" | undefined) {
  _focusStore.setState((s) => {
    const nextCurrent = modality ? modality : "input";
    return { ...s, modality, current: nextCurrent };
  });
}

export function setHidden(hiddenMap: Partial<Record<FocusTarget, boolean>>) {
  _focusStore.setState((s) => {
    const nextHidden = new Set(s.hidden);
    let changed = false;
    for (const [k, v] of Object.entries(hiddenMap)) {
      const target = k as FocusTarget;
      if (v && !nextHidden.has(target)) {
        nextHidden.add(target);
        changed = true;
      } else if (!v && nextHidden.has(target)) {
        nextHidden.delete(target);
        changed = true;
      }
    }
    if (!changed) return s;
    
    // 当前 focus 落到隐藏目标时自动回 input
    let nextCurrent = s.current;
    if (nextHidden.has(nextCurrent)) {
      nextCurrent = "input";
    }
    
    return { ...s, hidden: nextHidden, current: nextCurrent };
  });
}
