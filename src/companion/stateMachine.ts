import type { CompanionState } from "./types.js";
import { emitCompanionEvent } from "./stateBus.js";

export interface StateMachine {
  current(): CompanionState;
  setState(s: CompanionState, reason?: string): void;
  onChange(fn: (s: CompanionState, prev: CompanionState) => void): () => void;
  dispose(): void;
}

const DONE_TIMEOUT_MS = 5000;
const ERROR_TIMEOUT_MS = 8000;

class StateMachineImpl implements StateMachine {
  private _current: CompanionState = "idle";
  private _listeners = new Set<(s: CompanionState, prev: CompanionState) => void>();
  private _timer: ReturnType<typeof setTimeout> | null = null;

  current(): CompanionState {
    return this._current;
  }

  setState(s: CompanionState, reason?: string): void {
    if (this._current === s) return;
    const prev = this._current;
    this._current = s;

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    if (s === "done") {
      this._timer = setTimeout(() => this.setState("idle", "auto-decay"), DONE_TIMEOUT_MS);
    } else if (s === "error") {
      this._timer = setTimeout(() => this.setState("idle", "auto-decay"), ERROR_TIMEOUT_MS);
    }

    for (const cb of [...this._listeners]) {
      try {
        cb(s, prev);
      } catch {
        // ignore
      }
    }

    emitCompanionEvent({ type: "state", state: s, reason });
  }

  onChange(fn: (s: CompanionState, prev: CompanionState) => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  dispose(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._listeners.clear();
  }
}

export function createStateMachine(): StateMachine {
  return new StateMachineImpl();
}

let instance: StateMachineImpl | null = null;

export function getCompanionStateMachine(): StateMachine {
  if (!instance) {
    instance = new StateMachineImpl();
  }
  return instance;
}

export function _resetStateMachineForTesting(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
