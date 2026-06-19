export interface ARGBFrame {
  width: number;
  height: number;
  data: Uint8Array;
  delayMs: number;
}

export interface GifMeta {
  frames: ARGBFrame[];
  loopCount: number;
  bgColor?: [number, number, number];
}

// Internal structures used during parsing
export interface RawFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  localColorTable?: Uint8Array;
  transparentIndex?: number;
  delayMs: number;
  disposalMethod: number; // 0=unspecified, 1=keep, 2=restore bg, 3=restore prev
}

export interface RawGifMeta {
  width: number;
  height: number;
  globalColorTable?: Uint8Array;
  bgColorIndex?: number;
  frames: RawFrame[];
  loopCount: number;
}

export type CompanionState = "idle" | "work" | "think" | "done" | "error";

export interface CompanionFrame {
  ansi: string;
  widthCols: number;
  heightRows: number;
  delayMs: number;
}
