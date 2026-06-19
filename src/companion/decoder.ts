import type { ARGBFrame, GifMeta } from "./types";
import { parseGif } from "./decode-gif/parser";
import { FrameRenderer } from "./decode-gif/disposal";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function scaleNearest(src: Uint8Array, sw: number, sh: number, targetCols: number): { width: number; height: number; data: Uint8Array } {
  // Terminal character width ≈ pixel × 1; half-block characters mean 2 pixel rows = 1 character row
  // So 'character cols = targetCols' corresponds to 'pixel width = targetCols'
  const newW = clamp(targetCols, 8, 28);
  let newH = Math.round(sh * (newW / sw));
  if (newH % 2 !== 0) newH++; // Even out

  const dst = new Uint8Array(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / newH));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / newW));
      const s = (sy * sw + sx) * 4;
      const d = (y * newW + x) * 4;
      dst[d] = src[s]!;
      dst[d + 1] = src[s + 1]!;
      dst[d + 2] = src[s + 2]!;
      dst[d + 3] = src[s + 3]!;
    }
  }
  return { width: newW, height: newH, data: dst };
}

export async function decodeGif(path: string, targetCols: number, ctx: { abortSignal?: AbortSignal }): Promise<GifMeta> {
  if (ctx.abortSignal?.aborted) throw new Error("aborted");
  
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
  const raw = parseGif(buf);

  let bgColor: [number, number, number, number] = [0, 0, 0, 0];
  // Note: bgColor is often transparency in modern gifs. In some cases we might use the index.
  if (raw.globalColorTable && raw.bgColorIndex !== undefined && raw.bgColorIndex * 3 + 2 < raw.globalColorTable.length) {
    // Actually most buddy gifs have transparent backgrounds anyway.
    bgColor = [
      raw.globalColorTable[raw.bgColorIndex * 3]!,
      raw.globalColorTable[raw.bgColorIndex * 3 + 1]!,
      raw.globalColorTable[raw.bgColorIndex * 3 + 2]!,
      0 // Default to transparent for safety in terminal overlays
    ];
  }

  const renderer = new FrameRenderer(raw.width, raw.height, bgColor);
  const frames: ARGBFrame[] = [];

  for (const rf of raw.frames) {
    if (ctx.abortSignal?.aborted) throw new Error("aborted");
    
    const canvas = renderer.renderFrame(rf, raw.globalColorTable);
    const scaled = scaleNearest(canvas, raw.width, raw.height, targetCols);
    
    frames.push({
      ...scaled,
      delayMs: rf.delayMs || 40
    });
  }

  let finalBgColor: [number, number, number] | undefined;
  if (bgColor[3] === 255) {
    finalBgColor = [bgColor[0], bgColor[1], bgColor[2]];
  }

  return {
    frames,
    loopCount: raw.loopCount,
    bgColor: finalBgColor
  };
}
