import { useEffect, useState, useRef, type ReactElement } from "react";
import { Box, Text } from "ink";
import { useTerminalCaps } from "../tui/capabilities.js";
import { getCompanionStateMachine } from "./stateMachine.js";
import type { CompanionState } from "./types.js";
import { SpeechBubble } from "./speechBubble.js";
import { CompanionPlayer } from "./player.js";
import { pickQuip } from "./quips.js";
import { useTheme } from "../theme/index.js";
import { FALLBACKS } from "./ascii-fallback.js";
import { resolveGifPath } from "./skin.js";
import { useUserSkin, useCompanionMuted } from "./index.js";
import { t } from "../i18n/index.js";

function NarrowFace({ state, reaction }: { state: CompanionState; reaction?: string }) {
  const theme = useTheme();
  const face = FALLBACKS[state]?.[0] || FALLBACKS.idle[0];
  return (
    <Box paddingX={1} alignSelf="flex-end">
      <Text color={theme.primary} bold>{face}</Text>
      {reaction ? <Text italic color={theme.accent}> {reaction.slice(0, 24)}</Text> : null}
    </Box>
  );
}

export function CompanionHost({ cwd, reservedCols }: { cwd: string; reservedCols?: number }): ReactElement | null {
  const caps = useTerminalCaps();
  const sm = getCompanionStateMachine();
  const [state, setState] = useState<CompanionState>(sm.current());
  const [skin] = useUserSkin();
  const [muted] = useCompanionMuted();
  const [reaction, setReaction] = useState<string | undefined>(undefined);

  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => sm.onChange((s) => {
    setState(s);
    if (s === "done") {
      setReaction(t(pickQuip("done")));
    } else if (s === "error") {
      setReaction(t(pickQuip("error")));
    } else if (s === "work" || s === "idle") {
      setReaction(undefined);
    }
  }), [sm]);

  useEffect(() => {
    if (reactionTimerRef.current) {
      clearTimeout(reactionTimerRef.current);
      reactionTimerRef.current = null;
    }
    if (reaction) {
      reactionTimerRef.current = setTimeout(() => {
        setReaction(undefined);
      }, 8000);
    }
    return () => {
      if (reactionTimerRef.current) {
        clearTimeout(reactionTimerRef.current);
      }
    };
  }, [reaction]);

  if (muted || process.env["CHOVY_NO_COMPANION"] === "1") return null;
  if (caps.cols < 60) return <NarrowFace state={state} reaction={reaction} />;
  
  const cols = caps.cols < 100 ? 16 : Math.min(reservedCols ?? 20, 22);
  const gifPath = resolveGifPath(state, skin, cwd);

  return (
    <Box flexDirection="row" alignItems="flex-end" paddingX={1} flexShrink={0}>
      {reaction ? <SpeechBubble text={reaction} state={state}/> : null}
      <CompanionPlayer gifPath={gifPath} active cols={cols} />
    </Box>
  );
}
