import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../theme/index.js";
import { useSlideUp } from "../../tui/animations/useSlideUp.js";
import type { AskUserQuestionSpec, AskUserAnswer } from "../../types/index.js";
import { setModality } from "../state/focusStore.js";
// Removed getBinding since not used directly or kept if we need it

// Global state
type AskResolve = (ans: AskUserAnswer) => void;
type AskReject = (err: Error) => void;

let _activeSpecs: AskUserQuestionSpec[] | null = null;
let _resolve: AskResolve | null = null;
let _reject: AskReject | null = null;
const _listeners = new Set<() => void>();

function notify() {
  for (const l of _listeners) l();
}

export function openAskUser(specs: AskUserQuestionSpec[]): Promise<AskUserAnswer> {
  if (_activeSpecs) return Promise.reject(new Error("Another askUser is already active"));
  return new Promise((resolve, reject) => {
    _activeSpecs = specs;
    _resolve = resolve;
    _reject = reject;
    setModality("askUser");
    notify();
  });
}

export function abortAskUser() {
  if (!_activeSpecs) return;
  const r = _reject;
  _activeSpecs = null;
  _resolve = null;
  _reject = null;
  setModality(undefined);
  notify();
  if (r) r(new Error("User aborted question"));
}

function resolveAskUser(ans: AskUserAnswer) {
  const r = _resolve;
  _activeSpecs = null;
  _resolve = null;
  _reject = null;
  setModality(undefined);
  notify();
  if (r) r(ans);
}

export function useAskUserState() {
  const [specs, setSpecs] = useState(_activeSpecs);
  useEffect(() => {
    const cb = () => setSpecs(_activeSpecs);
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  }, []);
  return specs;
}

export function AskUserOverlay() {
  const specs = useAskUserState();
  const theme = useTheme();
  const { offset } = useSlideUp(!!specs, 3);
  
  const [qIdx, setQIdx] = useState(0);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [cursor, setCursor] = useState(0);

  // Reset local state when specs changes
  useEffect(() => {
    if (specs) {
      setQIdx(0);
      setCursor(0);
      setSelections({});
    }
  }, [specs]);

  useInput((_input, key) => {
    if (!specs) return;
    
    if (key.escape) {
      abortAskUser();
      return;
    }

    const currentQ = specs[qIdx];
    if (!currentQ) return;
    const opts = currentQ.options;

    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(opts.length - 1, c + 1));
    } else if (key.return) {
      const selectedLabel = opts[cursor]?.label;
      if (!selectedLabel) return;

      const newSelections = { ...selections };
      if (currentQ.multiSelect) {
        const set = new Set(newSelections[currentQ.question] || []);
        if (set.has(selectedLabel)) set.delete(selectedLabel);
        else set.add(selectedLabel);
        newSelections[currentQ.question] = set;
        setSelections(newSelections);
      } else {
        newSelections[currentQ.question] = new Set([selectedLabel]);
        setSelections(newSelections);
        // Move to next question or resolve
        if (qIdx < specs.length - 1) {
          setQIdx(qIdx + 1);
          setCursor(0);
        } else {
          // Finalize
          const ans: AskUserAnswer = {};
          for (const q of specs) {
            const set = newSelections[q.question] || new Set();
            ans[q.question] = Array.from(set).join(", ");
          }
          ans[currentQ.question] = selectedLabel; // Ensure current is saved if not multiSelect
          resolveAskUser(ans);
        }
      }
    } else if (key.rightArrow && currentQ.multiSelect) {
        // Move to next question if multiselect
        if (qIdx < specs.length - 1) {
          setQIdx(qIdx + 1);
          setCursor(0);
        } else {
          // Finalize
          const ans: AskUserAnswer = {};
          for (const q of specs) {
            const set = selections[q.question] || new Set();
            ans[q.question] = Array.from(set).join(", ");
          }
          resolveAskUser(ans);
        }
    }
  }, { isActive: !!specs });

  if (!specs) return null;

  const currentQ = specs[qIdx];
  if (!currentQ) return null;

  const currentSelections = selections[currentQ.question] || new Set();

  return (
    <Box flexDirection="column" marginTop={offset} borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={theme.primary}>{` Ask: ${currentQ.header} (${qIdx + 1}/${specs.length}) `}</Text>
        <Text dimColor>{`Esc 取消 · ↑/↓ 选择 · Enter ${currentQ.multiSelect ? '切换' : '确认'}${currentQ.multiSelect ? ' · → 下一步/完成' : ''}`}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold>{currentQ.question}</Text>
        {currentQ.multiSelect ? <Text dimColor> (多选)</Text> : null}
      </Box>
      <Box flexDirection="column">
        {currentQ.options.map((opt, i) => {
          const isSelected = currentSelections.has(opt.label);
          const isCursor = i === cursor;
          let prefix = "  ";
          if (currentQ.multiSelect) {
            prefix = isSelected ? "[x]" : "[ ]";
          }
          return (
            <Box key={opt.label}>
              <Text color={isCursor ? theme.accent : undefined}>
                {isCursor ? "▶ " : "  "}
                {prefix} {opt.label}
              </Text>
              {opt.description ? (
                <Text dimColor> - {opt.description}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
