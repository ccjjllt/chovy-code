import { useState, useEffect } from "react";
import { ANIM_ENABLED } from "./tokens.js";

export function useTypewriter(text: string, charPerTick = 2, intervalMs = 40): string {
  const [shown, setShown] = useState("");

  useEffect(() => {
    if (!ANIM_ENABLED) return;
    setShown("");
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(text.length, i + charPerTick);
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, intervalMs);
    return () => clearInterval(id);
  }, [text, charPerTick, intervalMs]);

  if (!ANIM_ENABLED) return text;
  return shown;
}
