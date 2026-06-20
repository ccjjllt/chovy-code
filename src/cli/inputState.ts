export interface InputState {
  buffer: string;
  cursor: number;
  mode: "normal" | "search" | "pastePreview";
  searchQuery: string;
  searchMatch?: { entry: string; index: number };
  pasteBuffer?: string;
  historyIdx: number | null;
}

export type InputAction =
  | { type: "TYPED"; text: string }
  | { type: "MOVE_CURSOR"; offset: number }
  | { type: "DELETE"; count: number; dir: "left" | "right" }
  | { type: "START_SEARCH" }
  | { type: "SEARCH_TYPED"; text: string; history: string[] }
  | { type: "SEARCH_DELETE"; history: string[] }
  | { type: "SEARCH_NEXT"; history: string[] }
  | { type: "SEARCH_CANCEL" }
  | { type: "SEARCH_COMMIT" }
  | { type: "PASTE_DETECTED"; text: string }
  | { type: "PASTE_COMMIT" }
  | { type: "PASTE_CANCEL" }
  | { type: "HISTORY_UP"; history: string[] }
  | { type: "HISTORY_DOWN"; history: string[] }
  | { type: "TAB_COMPLETE"; text: string }
  | { type: "RESET" }
  | { type: "SET_BUFFER"; text: string; cursor?: number };

function findMatch(history: string[], query: string, startIdx: number): { entry: string; index: number } | undefined {
  if (!query) return undefined;
  for (let i = startIdx; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.includes(query)) {
      return { entry, index: i };
    }
  }
  return undefined;
}

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case "TYPED": {
      if (state.mode !== "normal") return state;
      const nextBuf = state.buffer.slice(0, state.cursor) + action.text + state.buffer.slice(state.cursor);
      return { ...state, buffer: nextBuf, cursor: state.cursor + action.text.length, historyIdx: null };
    }
    case "TAB_COMPLETE": {
      if (state.mode !== "normal") return state;
      // replace the current command head with text
      const headMatch = state.buffer.match(/^(\/\S*)/);
      if (!headMatch) return state;
      const nextBuf = action.text + state.buffer.slice(headMatch[0].length);
      return { ...state, buffer: nextBuf, cursor: action.text.length };
    }
    case "MOVE_CURSOR": {
      if (state.mode !== "normal") return state;
      const nextCursor = Math.max(0, Math.min(state.buffer.length, state.cursor + action.offset));
      return { ...state, cursor: nextCursor };
    }
    case "DELETE": {
      if (state.mode !== "normal") return state;
      if (action.dir === "left" && state.cursor > 0) {
        const nextBuf = state.buffer.slice(0, state.cursor - action.count) + state.buffer.slice(state.cursor);
        return { ...state, buffer: nextBuf, cursor: state.cursor - action.count };
      } else if (action.dir === "right" && state.cursor < state.buffer.length) {
        const nextBuf = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + action.count);
        return { ...state, buffer: nextBuf };
      }
      return state;
    }
    case "HISTORY_UP": {
      if (action.history.length === 0) return state;
      const nextIdx = state.historyIdx === null ? action.history.length - 1 : Math.max(0, state.historyIdx - 1);
      const v = action.history[nextIdx] ?? "";
      return { ...state, historyIdx: nextIdx, buffer: v, cursor: v.length };
    }
    case "HISTORY_DOWN": {
      if (state.historyIdx === null) return state;
      const nextIdx = state.historyIdx + 1;
      if (nextIdx >= action.history.length) {
        return { ...state, historyIdx: null, buffer: "", cursor: 0 };
      }
      const v = action.history[nextIdx] ?? "";
      return { ...state, historyIdx: nextIdx, buffer: v, cursor: v.length };
    }
    case "START_SEARCH":
      return { ...state, mode: "search", searchQuery: "", searchMatch: undefined };
    case "SEARCH_TYPED": {
      const q = state.searchQuery + action.text;
      return { ...state, searchQuery: q, searchMatch: findMatch(action.history, q, action.history.length - 1) };
    }
    case "SEARCH_DELETE": {
      if (state.searchQuery.length > 0) {
        const q = state.searchQuery.slice(0, -1);
        return { ...state, searchQuery: q, searchMatch: findMatch(action.history, q, action.history.length - 1) };
      }
      return state;
    }
    case "SEARCH_NEXT": {
      const startIdx = state.searchMatch ? state.searchMatch.index - 1 : action.history.length - 1;
      const match = findMatch(action.history, state.searchQuery, startIdx);
      if (match) return { ...state, searchMatch: match };
      return state;
    }
    case "SEARCH_CANCEL":
      return { ...state, mode: "normal", searchQuery: "", searchMatch: undefined };
    case "SEARCH_COMMIT":
      if (state.searchMatch) {
        return { 
          ...state, 
          mode: "normal", 
          buffer: state.searchMatch.entry, 
          cursor: state.searchMatch.entry.length,
          searchQuery: "", 
          searchMatch: undefined,
          historyIdx: state.searchMatch.index
        };
      }
      return { ...state, mode: "normal", searchQuery: "", searchMatch: undefined };
    case "PASTE_DETECTED":
      return { ...state, mode: "pastePreview", pasteBuffer: action.text };
    case "PASTE_COMMIT":
      if (state.pasteBuffer) {
        const nextBuf = state.buffer.slice(0, state.cursor) + state.pasteBuffer + state.buffer.slice(state.cursor);
        return {
          ...state,
          mode: "normal",
          buffer: nextBuf,
          cursor: state.cursor + state.pasteBuffer.length,
          pasteBuffer: undefined
        };
      }
      return { ...state, mode: "normal" };
    case "PASTE_CANCEL":
      return { ...state, mode: "normal", pasteBuffer: undefined };
    case "SET_BUFFER":
      return { ...state, buffer: action.text, cursor: action.cursor ?? action.text.length, mode: "normal" };
    case "RESET":
      return { buffer: "", cursor: 0, mode: "normal", searchQuery: "", searchMatch: undefined, pasteBuffer: undefined, historyIdx: null };
    default:
      return state;
  }
}
