import React from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { useTheme } from "../theme/index.js";
import { inputReducer } from "./inputState.js";
import { SlashHint, searchSlashCommands, findActiveSlash } from "./slashHint.js";
import { feedKey, resetPasteDetector } from "./pasteDetector.js";
import { wrapByDisplayWidth } from "../tui/stringWidth.js";
import type { ReplCtx } from "./slashCommands.js";

interface Props {
  disabled?: boolean;
  history: string[];
  onSubmit(text: string): void;
  onCancel?(): void;
  onCtrlC?(): void;
  prompt?: string;
  autoSlashHint?: boolean;
  pasteDetect?: boolean;
  ctx?: ReplCtx;
}

function computeCursorPos(lines: string[], cursorOffset: number) {
  let offset = 0;
  for (let row = 0; row < lines.length; row++) {
    const lineLen = lines[row]?.length ?? 0;
    if (cursorOffset >= offset && cursorOffset < offset + lineLen) {
      return { row, col: cursorOffset - offset };
    }
    offset += lineLen;
  }
  if (lines.length === 0) return { row: 0, col: 0 };
  const lastRow = lines.length - 1;
  return { row: lastRow, col: lines[lastRow]?.length ?? 0 };
}

export function InputBoxV2Impl({
  disabled,
  history,
  onSubmit,
  onCancel,
  onCtrlC,
  prompt = "❯",
  autoSlashHint = true,
  pasteDetect = true,
  ctx,
}: Props): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const innerCols = Math.max(10, cols - 4); // accounting for border/prompt

  const [state, dispatch] = React.useReducer(inputReducer, {
    buffer: "",
    cursor: 0,
    mode: "normal",
    searchQuery: "",
    historyIdx: null,
  });

  const submit = () => {
    if (state.buffer.trim().length === 0) return;
    onSubmit(state.buffer);
    dispatch({ type: "RESET" });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onCtrlC?.(); return; }
    
    if (key.escape) {
      if (state.mode === "search") {
        dispatch({ type: "SEARCH_CANCEL" });
        return;
      }
      if (disabled) onCancel?.();
      else dispatch({ type: "RESET" });
      return;
    }

    if (disabled) return;

    if (state.mode === "search") {
      if (key.return) {
        dispatch({ type: "SEARCH_COMMIT" });
      } else if (key.backspace || key.delete) {
        dispatch({ type: "SEARCH_DELETE", history });
      } else if (key.ctrl && input === "r") {
        dispatch({ type: "SEARCH_NEXT", history });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "SEARCH_TYPED", text: input, history });
      }
      return;
    }

    if (state.mode === "pastePreview") {
      if (key.return) {
        dispatch({ type: "PASTE_COMMIT" });
      } else if (key.ctrl && input === "e") {
        dispatch({ type: "PASTE_COMMIT" });
      } else {
        dispatch({ type: "PASTE_CANCEL" });
      }
      return;
    }

    const now = Date.now();
    if (pasteDetect && input && !key.ctrl && !key.meta && !key.return) {
      const res = feedKey(input, now);
      if (res.flushed) {
        dispatch({ type: "PASTE_DETECTED", text: res.flushed });
        return;
      }
      if (res.isPaste) return;
    } else {
      resetPasteDetector();
    }

    if (key.return) {
      if (key.shift || key.meta || (key.ctrl && input === "j")) {
        dispatch({ type: "TYPED", text: "\n" });
        return;
      }
      submit();
      return;
    }

    if (key.tab && autoSlashHint) {
      const slash = findActiveSlash(state.buffer);
      if (slash && slash.commandHead) {
        const matches = searchSlashCommands(slash.commandHead, ctx);
        if (matches.length > 0) {
          const top = matches[0]!;
          dispatch({ type: "TAB_COMPLETE", text: top.display + " " });
          return;
        }
      }
    }

    if (key.ctrl && input === "r") {
      dispatch({ type: "START_SEARCH" });
      return;
    }

    if (key.upArrow) {
      dispatch({ type: "HISTORY_UP", history });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: "HISTORY_DOWN", history });
      return;
    }
    
    if (key.leftArrow) {
      dispatch({ type: "MOVE_CURSOR", offset: -1 });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: "MOVE_CURSOR", offset: 1 });
      return;
    }

    if (key.backspace || key.delete) {
      dispatch({ type: "DELETE", count: 1, dir: "left" });
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      dispatch({ type: "TYPED", text: input });
    }
  });

  if (state.mode === "search") {
    const matchLine = state.searchMatch ? state.searchMatch.entry : "";
    return (
      <Box flexDirection="column" borderStyle={theme.borderStyle as any} borderColor={theme.muted}>
        <Text color={theme.accent}>{`(reverse-i-search)\`${state.searchQuery}': `}<Text dimColor>{matchLine}</Text></Text>
      </Box>
    );
  }

  if (state.mode === "pastePreview") {
    return (
      <Box flexDirection="column" borderStyle={theme.borderStyle as any} borderColor={theme.muted}>
        <Text color={theme.warning} bold>{prompt} </Text>
        <Text dimColor>{`[粘贴 ${state.pasteBuffer?.length} 字符] (Enter 提交 / Ctrl+E 展开编辑)`}</Text>
      </Box>
    );
  }

  const lines = wrapByDisplayWidth(state.buffer, innerCols);
  const { row: cursorRow, col: cursorCol } = computeCursorPos(lines, state.cursor);

  function renderWithCursor(l: string, col: number) {
    const before = l.slice(0, col);
    const at = l.slice(col, col + 1);
    const after = l.slice(col + 1);
    return (
      <Text>
        {before}
        <Text inverse>{at.length > 0 ? at : " "}</Text>
        {after}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" borderStyle={theme.borderStyle as any} borderColor={theme.muted}>
      {lines.length === 0 ? (
        <Text>
          <Text color={disabled ? theme.warning : theme.primary} bold>{`${prompt} `}</Text>
          <Text inverse>{" "}</Text>
        </Text>
      ) : (
        lines.map((l, i) => (
          <Box key={i}>
            {i === 0 && <Text color={disabled ? theme.warning : theme.primary} bold>{`${prompt} `}</Text>}
            {i > 0 && <Text dimColor>{"  "}</Text>}
            {i === cursorRow ? renderWithCursor(l, cursorCol) : <Text>{l}</Text>}
          </Box>
        ))
      )}
      
      {state.buffer.length === 0 ? (
        <Text dimColor>
          {disabled
            ? "  正在执行（Esc 中断 · Ctrl+C 退出）"
            : "  输入消息或 /help"}
        </Text>
      ) : null}

      {autoSlashHint && <SlashHint buffer={state.buffer} ctx={ctx} />}
    </Box>
  );
}

export const InputBox = React.memo(InputBoxV2Impl);
