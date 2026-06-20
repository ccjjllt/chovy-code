import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../../theme/index.js";
import { useSlideUp } from "../../tui/animations/useSlideUp.js";
import { setModality } from "../state/focusStore.js";
import { DiffView } from "./DiffView.js";

type AskPermissionResolve = (ans: "allow" | "deny" | "always") => void;

interface PermSpec {
  toolName: string;
  args: any;
  reason: string;
}

let _activeSpec: PermSpec | null = null;
let _resolve: AskPermissionResolve | null = null;
const _listeners = new Set<() => void>();

function notify() {
  for (const l of _listeners) l();
}

export function openPermissionPrompt(toolName: string, args: any, reason: string): Promise<"allow" | "deny" | "always"> {
  if (_activeSpec) return Promise.resolve("deny"); // fail closed if busy
  return new Promise((resolve) => {
    _activeSpec = { toolName, args, reason };
    _resolve = resolve;
    setModality("askUser");
    notify();
  });
}

export function abortPermissionPrompt() {
  if (!_activeSpec) return;
  const r = _resolve;
  _activeSpec = null;
  _resolve = null;
  setModality(undefined);
  notify();
  if (r) r("deny");
}

function resolvePerm(ans: "allow" | "deny" | "always") {
  const r = _resolve;
  _activeSpec = null;
  _resolve = null;
  setModality(undefined);
  notify();
  if (r) r(ans);
}

export function usePermissionState() {
  const [spec, setSpec] = useState(_activeSpec);
  useEffect(() => {
    const cb = () => setSpec(_activeSpec);
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  }, []);
  return spec;
}

// Removed DiffPreview in favor of DiffView

export function PermissionPromptOverlay() {
  const spec = usePermissionState();
  const theme = useTheme();
  const { offset } = useSlideUp(!!spec, 3);
  
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (spec) setCursor(0);
  }, [spec]);

  useInput((_input, key) => {
    if (!spec) return;
    
    if (key.escape) {
      abortPermissionPrompt();
      return;
    }

    if (key.upArrow || key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || key.rightArrow) {
      setCursor((c) => Math.min(2, c + 1));
    } else if (key.return) {
      if (cursor === 0) resolvePerm("allow");
      else if (cursor === 1) resolvePerm("always");
      else resolvePerm("deny");
    }
  }, { isActive: !!spec });

  if (!spec) return null;

  return (
    <Box flexDirection="column" marginTop={offset} borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={theme.warning}> ⚠️ Permission: {spec.toolName} </Text>
        <Text dimColor>Esc 拒绝 · ←/→ 选择 · Enter 确认</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>Agent is requesting to run <Text bold>{spec.toolName}</Text></Text>
      </Box>
      
      <DiffView toolName={spec.toolName} args={spec.args} />

      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text color={cursor === 0 ? theme.accent : undefined}>{cursor === 0 ? "▶ " : "  "}Yes (Once)</Text>
        <Text color={cursor === 1 ? theme.accent : undefined}>{cursor === 1 ? "▶ " : "  "}Always (Session)</Text>
        <Text color={cursor === 2 ? theme.error : undefined}>{cursor === 2 ? "▶ " : "  "}No (Deny)</Text>
      </Box>
    </Box>
  );
}
