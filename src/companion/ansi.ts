import type { ARGBFrame } from "./types";

export interface RenderOpts {
  alphaThreshold: number;
  trueColor: boolean;
}

const ansi16Colors = [
  { r: 0,   g: 0,   b: 0,   id: 30 }, // Black
  { r: 205, g: 0,   b: 0,   id: 31 }, // Red
  { r: 0,   g: 205, b: 0,   id: 32 }, // Green
  { r: 205, g: 205, b: 0,   id: 33 }, // Yellow
  { r: 0,   g: 0,   b: 238, id: 34 }, // Blue
  { r: 205, g: 0,   b: 205, id: 35 }, // Magenta
  { r: 0,   g: 205, b: 205, id: 36 }, // Cyan
  { r: 229, g: 229, b: 229, id: 37 }, // White
  { r: 127, g: 127, b: 127, id: 90 }, // Bright Black (Gray)
  { r: 255, g: 0,   b: 0,   id: 91 }, // Bright Red
  { r: 0,   g: 255, b: 0,   id: 92 }, // Bright Green
  { r: 255, g: 255, b: 0,   id: 93 }, // Bright Yellow
  { r: 92,  g: 92,  b: 255, id: 94 }, // Bright Blue
  { r: 255, g: 0,   b: 255, id: 95 }, // Bright Magenta
  { r: 0,   g: 255, b: 255, id: 96 }, // Bright Cyan
  { r: 255, g: 255, b: 255, id: 97 }  // Bright White
];

function nearestAnsi8(r: number, g: number, b: number): number {
  let best = 30;
  let minDist = Infinity;
  for (const c of ansi16Colors) {
    const dr = c.r - r;
    const dg = c.g - g;
    const db = c.b - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < minDist) {
      minDist = dist;
      best = c.id;
    }
  }
  return best;
}

function pickPx(frame: ARGBFrame, x: number, y: number) {
  const i = (y * frame.width + x) * 4;
  return {
    r: frame.data[i]!,
    g: frame.data[i + 1]!,
    b: frame.data[i + 2]!,
    a: frame.data[i + 3]!
  };
}

const transparent = { r: 0, g: 0, b: 0, a: 0 };

export function frameToAnsi(frame: ARGBFrame, opts: RenderOpts): string {
  const ESC = "\x1b";
  const sb: string[] = [];
  const thr = opts.alphaThreshold;

  for (let y = 0; y < frame.height; y += 2) {
    let lastSeq = "";
    for (let x = 0; x < frame.width; x++) {
      const top = pickPx(frame, x, y);
      const bot = y + 1 < frame.height ? pickPx(frame, x, y + 1) : transparent;
      
      const tv = top.a >= thr;
      const bv = bot.a >= thr;
      
      if (tv && bv) {
        let seq = "";
        if (opts.trueColor) {
          seq = `${ESC}[38;2;${top.r};${top.g};${top.b};48;2;${bot.r};${bot.g};${bot.b}m`;
        } else {
          const tColor = nearestAnsi8(top.r, top.g, top.b);
          const bColor = nearestAnsi8(bot.r, bot.g, bot.b) + 10; // bg is fg + 10
          seq = `${ESC}[${tColor};${bColor}m`;
        }
        
        if (seq !== lastSeq) { sb.push(seq); lastSeq = seq; }
        sb.push("\u2580");
      } else if (tv) {
        let seq = "";
        if (opts.trueColor) {
          seq = `${ESC}[0;38;2;${top.r};${top.g};${top.b}m`;
        } else {
          seq = `${ESC}[0;${nearestAnsi8(top.r, top.g, top.b)}m`;
        }

        if (seq !== lastSeq) { sb.push(seq); lastSeq = seq; }
        sb.push("\u2580");
      } else if (bv) {
        let seq = "";
        if (opts.trueColor) {
          seq = `${ESC}[0;38;2;${bot.r};${bot.g};${bot.b}m`;
        } else {
          seq = `${ESC}[0;${nearestAnsi8(bot.r, bot.g, bot.b)}m`;
        }
        
        if (seq !== lastSeq) { sb.push(seq); lastSeq = seq; }
        sb.push("\u2584");
      } else {
        if (lastSeq !== "RST") { sb.push(`${ESC}[0m`); lastSeq = "RST"; }
        sb.push(" ");
      }
    }
    sb.push(`${ESC}[0m\n`);
  }
  return sb.join("");
}
