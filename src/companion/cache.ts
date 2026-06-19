import * as path from "node:path";
import { createHash } from "node:crypto";
import { chovyHome } from "../config/home.js";
import { safeFs } from "../fs/safeFs.js";
import { decodeGif } from "./decoder.js";
import { frameToAnsi } from "./ansi.js";
import { detectTerminal } from "../tui/capabilities.js";
import { logger } from "../logger/index.js";
import type { GifMeta } from "./types.js";

function absolute(p: string): string {
  return path.resolve(p);
}

export async function cacheDirFor(gifPath: string): Promise<string> {
  const st = await safeFs.stat(gifPath);
  const mtimeMs = st ? st.mtime : 0;
  const hash = createHash("sha1").update(`${absolute(gifPath)}|${mtimeMs}|v1`).digest("hex").slice(0, 12);
  return path.join(chovyHome(), "cache", "companion", hash);
}

async function persistCache(dir: string, decoded: GifMeta, ansiFrames: string[], targetCols: number): Promise<void> {
  await safeFs.mkdirp(dir);
  
  const meta = {
    v: 1,
    targetCols,
    widthCols: decoded.frames[0]?.width ?? 0,
    heightRows: decoded.frames[0]?.height ?? 0,
    frames: decoded.frames.map(f => ({ delayMs: f.delayMs }))
  };
  
  await safeFs.write(path.join(dir, "meta.json"), JSON.stringify(meta));
  
  for (let i = 0; i < ansiFrames.length; i++) {
    await safeFs.write(path.join(dir, `frame-${String(i).padStart(3, "0")}.ansi`), ansiFrames[i]!);
  }
}

export async function loadFramesCached(gifPath: string, targetCols: number, signal?: AbortSignal): Promise<{ frames: { ansi: string; delayMs: number }[]; widthCols: number; heightRows: number }> {
  try {
    const dir = await cacheDirFor(gifPath);
    const metaPath = path.join(dir, "meta.json");
    if (await safeFs.exists(metaPath)) {
      const metaStr = await safeFs.read(metaPath);
      const meta = JSON.parse(metaStr);
      if (meta.v === 1 && meta.targetCols === targetCols) {
        const frames = await Promise.all(meta.frames.map(async (m: { delayMs: number }, i: number) => ({
          ansi: await safeFs.read(path.join(dir, `frame-${String(i).padStart(3, "0")}.ansi`)),
          delayMs: m.delayMs,
        })));
        return { frames, widthCols: meta.widthCols, heightRows: meta.heightRows };
      }
    }
    
    // miss → decode and write to disk
    const decoded = await decodeGif(gifPath, targetCols, { abortSignal: signal });
    if (!decoded.frames.length) throw new Error("No frames decoded");
    
    const trueColor = detectTerminal().trueColor;
    const ansi = decoded.frames.map(f => frameToAnsi(f, { alphaThreshold: 128, trueColor }));
    
    await persistCache(dir, decoded, ansi, targetCols);
    
    return {
      frames: decoded.frames.map((f, i) => ({ ansi: ansi[i]!, delayMs: f.delayMs })),
      widthCols: decoded.frames[0]!.width,
      heightRows: decoded.frames[0]!.height / 2,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.warn(`[companion] cache/decode failed for ${gifPath}: ${err}`);
    throw err;
  }
}
