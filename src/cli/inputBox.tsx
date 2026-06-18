import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  /** When true, the box renders a hint and ignores printable input — only
   *  Esc / Ctrl+C still fire (so the user can interrupt). */
  disabled?: boolean;
  /** Submitted prompts; older entries first. Up/Down navigates this list. */
  history: string[];
  onSubmit(text: string): void;
  /** Esc handler. While busy this is "abort"; while idle it just clears. */
  onCancel?(): void;
  /** Ctrl+C — REPL decides whether to interrupt or exit. */
  onCtrlC?(): void;
  prompt?: string;
}

/**
 * Multi-line input box with history.
 *
 *   - Enter           → submit (skipped if input is whitespace-only)
 *   - Shift+Enter / Alt+Enter → insert a newline at the cursor
 *   - ↑ / ↓           → walk history
 *   - ←  / →          → move cursor within the current line
 *   - Backspace/Delete → delete char before cursor
 *   - Esc             → cancel run if busy, otherwise clear input
 *   - Ctrl+C          → forwarded to caller
 *
 * step-13 may layer richer behaviours (autocompletion, paste capture); the
 * shape stays compatible because all keys we don't recognise fall through.
 */
export function InputBox({
  disabled,
  history,
  onSubmit,
  onCancel,
  onCtrlC,
  prompt = "❯",
}: Props): React.ReactElement {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);

  const submit = useCallback(() => {
    if (value.trim().length === 0) return;
    onSubmit(value);
    setValue("");
    setCursor(0);
    setHistoryIdx(null);
  }, [value, onSubmit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onCtrlC?.(); return; }
    if (key.escape) {
      if (disabled) onCancel?.();
      else { setValue(""); setCursor(0); setHistoryIdx(null); }
      return;
    }

    // While the agent is running we still need Esc/Ctrl+C above to fire,
    // but every other key is suppressed so users can't interleave input.
    if (disabled) return;

    if (key.return) {
      // Shift / Alt / Meta + Enter → newline; bare Enter submits.
      if (key.shift || key.meta) {
        const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
        setValue(next);
        setCursor(cursor + 1);
        return;
      }
      submit();
      return;
    }

    if (key.upArrow) {
      if (history.length === 0) return;
      const next = historyIdx === null
        ? history.length - 1
        : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      const v = history[next] ?? "";
      setValue(v);
      setCursor(v.length);
      return;
    }
    if (key.downArrow) {
      if (historyIdx === null) return;
      const next = historyIdx + 1;
      if (next >= history.length) {
        setHistoryIdx(null);
        setValue("");
        setCursor(0);
      } else {
        setHistoryIdx(next);
        const v = history[next] ?? "";
        setValue(v);
        setCursor(v.length);
      }
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(value.length, cursor + 1)); return; }

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setValue(value.slice(0, cursor - 1) + value.slice(cursor));
      setCursor(cursor - 1);
      return;
    }

    // Printable input. ink delivers pasted strings here in one call too.
    if (input && !key.ctrl && !key.meta) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      setValue(next);
      setCursor(cursor + input.length);
    }
  });

  // Render a single-line preview with a block cursor. Multi-line input is
  // visible because we render the whole `value` verbatim (Ink wraps it).
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);

  return (
    <Box>
      <Text color={disabled ? "yellow" : "cyan"} bold>{`${prompt} `}</Text>
      <Text>{before}</Text>
      <Text inverse>{at.length > 0 ? at : " "}</Text>
      <Text>{after}</Text>
      {value.length === 0 ? (
        <Text dimColor>
          {disabled
            ? "  正在执行（Esc 中断 · Ctrl+C 退出）"
            : "  输入消息或 /help"}
        </Text>
      ) : null}
    </Box>
  );
}
