import { useSyncExternalStore } from "react";
import { _focusStore, setModality } from "../cli/state/focusStore.js";

export type SettingsCategory = "general" | "provider" | "model" | "theme" | "language" | "keybind" | "advanced";

export interface SettingsState {
  open: boolean;
  category: SettingsCategory;
  highlightFieldId?: string;
  query: string;
  dirty: Record<string, string>;
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

const _store = createStore<SettingsState>({
  open: false,
  category: "general",
  query: "",
  dirty: {},
});

_focusStore.subscribe(() => {
  if (_focusStore.getState().modality !== "settings" && _store.getState().open) {
    _store.setState(s => ({ ...s, open: false, highlightFieldId: undefined }));
  }
});

export function useSettingsState(): SettingsState {
  return useSyncExternalStore(_store.subscribe, _store.getState);
}

// Coordinate with palette (step-48 risk handling)
export function openSettings(fieldId?: string) {
  setModality("settings");

  _store.setState((s) => {
    let nextCategory = s.category;
    // Simple mapping: if fieldId is e.g. "theme.name", default to "theme" category
    if (fieldId) {
      const parts = fieldId.split(".");
      if (parts[0] && ["general", "provider", "model", "theme", "language", "keybind", "advanced"].includes(parts[0])) {
        nextCategory = parts[0] as SettingsCategory;
      }
    }

    return {
      ...s,
      open: true,
      highlightFieldId: fieldId,
      category: nextCategory,
    };
  });
}

export function closeSettings(opts?: { discard?: boolean }) {
  setModality(undefined);
  _store.setState((s) => {
    const next = { ...s, open: false, highlightFieldId: undefined };
    if (opts?.discard) {
      next.dirty = {};
    }
    return next;
  });
}

export function setCategory(c: SettingsCategory) {
  _store.setState((s) => ({ ...s, category: c, highlightFieldId: undefined }));
}

export function setSettingsQuery(q: string) {
  _store.setState((s) => ({ ...s, query: q }));
}

export function setDirty(fieldId: string, value: string) {
  _store.setState((s) => {
    const next = { ...s.dirty, [fieldId]: value };
    return { ...s, dirty: next };
  });
}

export async function commitDirty() {
  const s = _store.getState();
  const keys = Object.keys(s.dirty);
  if (keys.length === 0) {
    closeSettings();
    return;
  }

  // Iterate through SettingsField registry and write()
  // Note: doing this in parallel or sequential is fine. Let's do sequential.
  // We need to import listSettingsFields from settingsTabs/index.ts
  const { listSettingsFields } = await import("./settingsTabs/index.js");
  const fields = listSettingsFields();
  
  for (const key of keys) {
    const field = fields.find(f => f.id === key);
    if (field) {
      await field.write(s.dirty[key]!);
    }
  }

  _store.setState((prev) => ({ ...prev, dirty: {}, open: false, highlightFieldId: undefined }));
}
