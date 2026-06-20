import { useSyncExternalStore } from "react";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastInput {
  id?: string;
  variant: ToastVariant;
  text: string;
  durationMs?: number;
}

export interface ToastEvent extends ToastInput {
  id: string;
  createdAt: number;
}

let _store: ToastEvent[] = [];
const _listeners = new Set<() => void>();

function emit() {
  _listeners.forEach(l => l());
}

export function showToast(input: ToastInput): string {
  const id = input.id ?? `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ev: ToastEvent = { ...input, id, createdAt: Date.now() };
  
  const idx = _store.findIndex(t => t.id === id);
  if (idx >= 0) {
    _store[idx] = ev;
    // to trigger react render, we should create a new array
    _store = [..._store];
  } else {
    _store = [..._store, ev];
  }
  emit();
  return id;
}

export function dismissToast(id: string): void {
  const newStore = _store.filter(t => t.id !== id);
  if (newStore.length !== _store.length) {
    _store = newStore;
    emit();
  }
}

export function useToasts(): ToastEvent[] {
  return useSyncExternalStore(
    (listener) => {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },
    () => _store
  );
}

// Test utility
export function _resetToasts() {
  _store = [];
  emit();
}

export function _getToastsSnapshot() {
  return _store;
}
