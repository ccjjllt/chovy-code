import { useState, useEffect } from "react";
import { ANIM_ENABLED, SLIDE_FRAMES, SLIDE_FRAME_MS } from "./tokens.js";

export function useSlideUp(active: boolean, lines: number): { offset: number } {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!ANIM_ENABLED) return;
    if (!active) {
      setTick(0);
      return;
    }
    const id = setInterval(() => setTick(t => {
      const next = t + 1;
      if (next >= SLIDE_FRAMES) clearInterval(id);
      return Math.min(next, SLIDE_FRAMES);
    }), SLIDE_FRAME_MS);

    return () => clearInterval(id);
  }, [active]);

  if (!ANIM_ENABLED) return { offset: 0 };
  // tick 0..5 -> offset lines..0
  return { offset: Math.max(0, lines - Math.round(lines * tick / SLIDE_FRAMES)) };
}
