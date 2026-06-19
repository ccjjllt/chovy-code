import type { Key } from "ink";

export interface KeyMatcher {
  modifiers: { ctrl: boolean; shift: boolean; meta: boolean };
  primary: string;        // "p" / "Tab" / "Enter" / "Up"
  chord?: string;         // 第二段（"L"），仅 Ctrl+X L 这类双键
}

export function parseKey(s: string): KeyMatcher {
  if (s === "Esc") {
    return { modifiers: { ctrl: false, shift: false, meta: false }, primary: "escape" };
  }

  const parts = s.split(" ");
  if (parts.length > 2) {
    throw new Error(`Invalid keybinding format: ${s}`);
  }

  const [head, chord] = parts;

  // Esc cannot be a chord head
  if (head === "Esc" && chord) {
    throw new Error(`Esc cannot be used as a chord head in keybinding: ${s}`);
  }

  const keys = (head ?? "").split("+");
  const modifiers = { ctrl: false, shift: false, meta: false };
  let primary = "";

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] ?? "";
    const lower = k.toLowerCase();
    if (lower === "ctrl") {
      modifiers.ctrl = true;
    } else if (lower === "shift") {
      modifiers.shift = true;
    } else if (lower === "meta" || lower === "alt") {
      modifiers.meta = true;
    } else {
      primary = lower;
    }
  }

  return {
    modifiers,
    primary,
    chord: chord ? chord.toLowerCase() : undefined,
  };
}

export function describeKey(input: string, key: Key): string | null {
  let primary = "";
  if (key.upArrow) primary = "Up";
  else if (key.downArrow) primary = "Down";
  else if (key.leftArrow) primary = "Left";
  else if (key.rightArrow) primary = "Right";
  else if (key.return) primary = "Enter";
  else if (key.escape) primary = "Esc";
  else if (key.tab) primary = "Tab";
  else if (key.backspace || key.delete) primary = "Backspace";
  else if (input) primary = input.toUpperCase();

  if (!primary) return null;

  const parts: string[] = [];
  if (key.ctrl) parts.push("Ctrl");
  if (key.meta) parts.push("Meta");
  if (key.shift) parts.push("Shift");

  if (parts.length === 0 && input && input.length === 1 && /^[a-zA-Z0-9.,/;'\\[\]\-=`]$/.test(input)) {
    return null;
  }

  parts.push(primary);
  return parts.join("+");
}

export function matchInkKey(
  matcher: KeyMatcher,
  input: string,
  key: Key,
  chordState: string | null
): { match: boolean; chordPending: boolean } {
  // Translate Ink key to primary string
  let currentPrimary = "";
  if (key.upArrow) currentPrimary = "up";
  else if (key.downArrow) currentPrimary = "down";
  else if (key.leftArrow) currentPrimary = "left";
  else if (key.rightArrow) currentPrimary = "right";
  else if (key.return) currentPrimary = "enter";
  else if (key.escape) currentPrimary = "escape";
  else if (key.tab) currentPrimary = "tab";
  else if (key.backspace || key.delete) currentPrimary = "backspace";
  else if (input) currentPrimary = input.toLowerCase();

  // If there's an active chord state
  if (chordState) {
    if (chordState === matcher.primary && matcher.chord) {
      if (currentPrimary === matcher.chord) {
        return { match: true, chordPending: false };
      }
    }
    // Any input during chord state clears or aborts unless it matched
    return { match: false, chordPending: false };
  }

  // Basic matcher check
  const modsMatch =
    !!key.ctrl === matcher.modifiers.ctrl &&
    !!key.shift === matcher.modifiers.shift &&
    !!key.meta === matcher.modifiers.meta;

  if (modsMatch && currentPrimary === matcher.primary) {
    if (matcher.chord) {
      return { match: false, chordPending: true };
    }
    return { match: true, chordPending: false };
  }

  return { match: false, chordPending: false };
}
