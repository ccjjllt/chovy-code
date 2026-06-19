import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { loadFramesCached } from "./cache.js";
import { AsciiFallback } from "./ascii-fallback.js";
import { logger } from "../logger/index.js";

interface CompanionPlayerProps {
  gifPath: string;
  active: boolean;
  cols: number;
  onReady?: () => void;
}

function normalizeCompanionCols(cols: number): number {
  return Math.max(8, Math.min(28, cols || 20));
}

export function CompanionPlayer({ gifPath, active, cols, onReady }: CompanionPlayerProps) {
  const targetCols = normalizeCompanionCols(cols);
  const [frames, setFrames] = useState<{ ansi: string; delayMs: number }[] | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    loadFramesCached(gifPath, targetCols, ac.signal).then(r => {
      if (ac.signal.aborted) return;
      setFrames(r.frames);
      setIdx(0);
      onReady?.();
    }).catch(err => {
      if (ac.signal.aborted) return;
      logger.warn(`[companion] decode failed: ${err}`);
      setFrames(null);
    });
    return () => ac.abort();
  }, [gifPath, targetCols, onReady]);

  useEffect(() => {
    if (!active || !frames || frames.length === 0) return;
    const cur = frames[idx]!;
    const delay = Math.max(80, cur.delayMs);
    const t = setTimeout(() => setIdx(i => (i + 1) % frames.length), delay);
    return () => clearTimeout(t);
  }, [active, frames, idx]);

  if (!frames) {
    return <AsciiFallback state="loading" />;
  }

  return (
    <Box>
      <Text>{frames[idx]!.ansi}</Text>
    </Box>
  );
}
