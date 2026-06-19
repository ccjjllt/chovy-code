import { useInput } from "ink";
import { useMemo } from "react";
import { parseKey, matchInkKey } from "./parse.js";
import { getBinding } from "./index.js";

// Global chord state across all useKeybinding instances
let globalChordState: string | null = null;
let chordTimeout: NodeJS.Timeout | null = null;

const CHORD_WINDOW_MS = 200;

export function useKeybinding(
  id: string,
  handler: () => void,
  opts?: { isActive?: boolean }
): void {
  const matcher = useMemo(() => parseKey(getBinding(id)), [id]);

  // Disable if not TTY
  const isTTY = Boolean(process.stdin.isTTY);
  const isActive = opts?.isActive !== false && isTTY;

  useInput(
    (input, key) => {
      if (!isActive) return;

      const r = matchInkKey(matcher, input, key, globalChordState);

      if (r.chordPending) {
        // Start chord window
        globalChordState = matcher.primary;
        if (chordTimeout) clearTimeout(chordTimeout);
        chordTimeout = setTimeout(() => {
          globalChordState = null;
          chordTimeout = null;
        }, CHORD_WINDOW_MS);
        return;
      }

      if (r.match) {
        // Matched, clear state
        globalChordState = null;
        if (chordTimeout) {
          clearTimeout(chordTimeout);
          chordTimeout = null;
        }
        handler();
        return;
      }

      // If we are currently in a chord state and this hook didn't match,
      // we don't necessarily clear it here because another useKeybinding
      // might match it (since useInput is called for all active hooks).
      // However, Ink fires useInput handlers sequentially. 
      // We will rely on the timeout to clear it if it's an invalid chord, 
      // or we could clear it if no hook matches, but we don't have a global hook registry.
      // Actually, if input happens during chord state, and it's not a match,
      // it might just be ignored until timeout.
    },
    { isActive }
  );
}
