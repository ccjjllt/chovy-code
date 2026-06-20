import { useEffect, useState, useRef, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalCaps } from "../tui/capabilities.js";
import { getCompanionStateMachine } from "./stateMachine.js";
import type { CompanionState } from "./types.js";
import { SpeechBubble } from "./speechBubble.js";
import { CompanionPlayer } from "./player.js";
import { pickQuip } from "./quips.js";
import { useTheme } from "../theme/index.js";
import { FALLBACKS } from "./ascii-fallback.js";
import { resolveGifPath } from "./skin.js";
import { useCompanionPrefs } from "./index.js";
import { t } from "../i18n/index.js";
import { companionBus } from "./stateBus.js";
import { setSkin } from "./prefs.js";
import { PetHearts } from "./pet.js";

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

export function CompanionHost({ cwd, reservedCols, focused }: { cwd: string; reservedCols?: number; focused?: boolean }): ReactElement | null {
  const caps = useTerminalCaps();
  const theme = useTheme();
  const sm = getCompanionStateMachine();
  const [state, setState] = useState<CompanionState>(sm.current());
  const prefs = useCompanionPrefs();
  const [reaction, setReaction] = useState<string | undefined>(undefined);
  const [petActive, setPetActive] = useState(false);

  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return companionBus.on((msg) => {
      if (msg.type === "pet") {
        setPetActive(true);
      }
    });
  }, []);

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

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      const skins = ["chovy", "cat", "dog", "fox", "owl"];
      const currentSkin = prefs.skin || "chovy";
      const idx = skins.indexOf(currentSkin);
      const nextIdx = (idx + (key.upArrow ? -1 : 1) + skins.length) % skins.length;
      setSkin(skins[nextIdx]!);
      return;
    }
    if (key.return) {
      companionBus.emit({ type: "pet" });
      return;
    }
  }, { isActive: !!focused });

  if (prefs.muted || !prefs.visible || process.env["CHOVY_NO_COMPANION"] === "1") return null;
  if (caps.cols < 60) return <NarrowFace state={state} reaction={reaction} />;
  
  let cols = 20;
  if (prefs.size === "compact") cols = 16;
  else if (prefs.size === "small") cols = 12;
  else cols = caps.cols < 100 ? 16 : Math.min(reservedCols ?? 20, 22);

  const gifPath = resolveGifPath(state, prefs.skin, cwd);

  return (
    <Box flexDirection="row" alignItems="flex-end" paddingX={1} flexShrink={0} borderStyle={focused ? "round" : undefined} borderColor={focused ? theme.accent : undefined}>
      {reaction ? <SpeechBubble text={reaction} state={state}/> : null}
      <Box flexDirection="column" alignItems="center">
        <PetHearts active={petActive} onDone={() => setPetActive(false)} />
        <CompanionPlayer gifPath={gifPath} active cols={cols} />
      </Box>
    </Box>
  );
}
