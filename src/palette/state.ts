import { useSyncExternalStore } from "react";
import { _focusStore, setModality } from "../cli/state/focusStore.js";

export interface PaletteCommand {
  id: string;
  label: () => string;
  hotkey?: string;
  run: (ctx: any) => void | Promise<void>;
  category?: string;
}

export interface Group {
  id: string;
  items: { item: PaletteCommand; result: import("./search.js").MatchResult }[];
}

export interface PaletteState {
  open: boolean;
  query: string;
  rawQuery: string;
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
  rawQuery: "",
  selectedIndex: 0,
});

_focusStore.subscribe(() => {
  if (_focusStore.getState().modality !== "palette" && _store.getState().open) {
    _store.setState(s => ({ ...s, open: false }));
  }
});

export function usePaletteState(): PaletteState {
  return useSyncExternalStore(_store.subscribe, _store.getState);
}

export function openPalette() {
  setModality("palette");
  _store.setState((s) => ({ ...s, open: true, query: "", rawQuery: "", selectedIndex: 0 }));
}

export function closePalette() {
  setModality(undefined);
  _store.setState((s) => ({ ...s, open: false }));
}

let _searchTimer: ReturnType<typeof setTimeout> | undefined;

export function setPaletteQuery(q: string) {
  _store.setState((s) => ({ ...s, rawQuery: q }));
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    _store.setState((s) => ({ ...s, query: q, selectedIndex: 0 }));
  }, 80);
}

export function movePaletteCursor(dir: -1 | 1) {
  _store.setState((s) => ({ ...s, selectedIndex: Math.max(0, s.selectedIndex + dir) }));
}
