import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { CompanionState } from "./types.js";

export const FALLBACKS: Record<CompanionState, string[]> = {
  idle:   ["( - . - )", "( - . - )", "( = . = )"],
  work:   ["( o _ o )", "( O _ O )", "( o _ O )"],
  think:  ["(?_?)",     "(?_? )",   "( ?_?)"],
  done:   ["( ^ . ^ )", "( ^ _ ^ )"],
  error:  ["( x _ x )", "( X _ X )"],
};

export interface AsciiFallbackProps {
  state: CompanionState | "loading";
}

export function AsciiFallback({ state }: AsciiFallbackProps) {
  const [idx, setIdx] = useState(0);

  const fallbackFrames = state === "loading" ? FALLBACKS.idle : FALLBACKS[state] ?? FALLBACKS.idle;

  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % fallbackFrames.length), 500);
    return () => clearInterval(t);
  }, [fallbackFrames]);

  return (
    <Box>
      <Text>{fallbackFrames[idx]}</Text>
    </Box>
  );
}
