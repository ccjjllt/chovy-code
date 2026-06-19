import { useSyncExternalStore } from "react";

export interface PaletteCommand {
  id: string;
  label: () => string;
  hotkey?: string;
  run: (ctx: any) => void | Promise<void>;
}

export interface Group {
  id: string;
  items: PaletteCommand[];
}

export interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
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

export const _store = createStore<PaletteState>({
  open: false,
  query: "",
  selectedIndex: 0,
});

export function usePaletteState(): PaletteState {
  return useSyncExternalStore(_store.subscribe, _store.getState);
}

export function openPalette() {
  _store.setState((s) => ({ ...s, open: true, query: "", selectedIndex: 0 }));
}

export function closePalette() {
  _store.setState((s) => ({ ...s, open: false }));
}

export function setPaletteQuery(q: string) {
  _store.setState((s) => ({ ...s, query: q, selectedIndex: 0 }));
}

export function movePaletteCursor(dir: -1 | 1) {
  _store.setState((s) => ({ ...s, selectedIndex: Math.max(0, s.selectedIndex + dir) }));
}
