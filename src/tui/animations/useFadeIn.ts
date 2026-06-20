import { useState, useEffect } from "react";
import { ANIM_ENABLED, FADE_FRAMES, FADE_FRAME_MS } from "./tokens.js";

export function useFadeIn(active: boolean): { dim: boolean } {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!ANIM_ENABLED) return;
    if (!active) { 
      setTick(0); 
      return; 
    }
    const id = setInterval(() => setTick(t => {
      const next = t + 1;
      if (next >= FADE_FRAMES) clearInterval(id);
      return Math.min(next, FADE_FRAMES);
    }), FADE_FRAME_MS);
    
    return () => clearInterval(id);
  }, [active]);

  if (!ANIM_ENABLED) return { dim: false };
  // 前一半时间 dim，后一半 normal
  return { dim: tick < FADE_FRAMES / 2 };
}
