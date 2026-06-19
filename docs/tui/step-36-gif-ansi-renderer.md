# Step 36 — GIF 解码 + ANSI 半块渲染核心

**Phase**: K | **依赖**: B8 (J 屏障) | **可并行**: 41, 45, 48 | **估时**: 4h | **创新**: BUDDY-GIF

## 目标

把 `gif/2026-06-12_*.GIF` 5 个真 GIF **本地**解码成 ARGB 帧序列 → 用 ▀▄ 半块字符 + ANSI 24-bit 真彩色渲染成
可直接 `console.write` 的字符串。无网络副作用，无外部 ImageMagick / ffmpeg 调用。

> 算法严格参考 `gif/Terminal-GIF-Player-main/play-gif.ps1` line 226-365（解码 + 预渲染部分）。

## 产物

```
src/companion/
├── decoder.ts        # GIF → { frames: ARGBFrame[]; widthCols: number; heightRows: number }
├── ansi.ts           # ARGB[] + opts → ANSI 字符串
├── decode-gif/       # 自实现 LZW + GIF block parser（≤ 400 行 + ≤ 200 行 LZW）
│   ├── parser.ts     # GIF87a / GIF89a header + block parser
│   ├── lzw.ts        # LZW 解码（GIF 风格）
│   └── disposal.ts   # disposal method 处理（restore/keep/clear）
└── types.ts          # ARGBFrame / GifMeta
```

## 实现要点

### 1. 是否引依赖？

**优先自实现**（≤ 600 行总代码，无依赖）；若 PR 评审认为代价过大，**可**引 `omggif`（≈ 12KB，纯 JS，无 native binding）——
PR 描述里**显式**说明（AGENTS.md §8 要求）。本 spec 默认走自实现路径。

### 2. ARGB 帧结构

```ts
// src/companion/types.ts
export interface ARGBFrame {
  width: number;          // 像素宽（缩放后）
  height: number;         // 像素高（缩放后，必为偶数 → 半块对齐）
  data: Uint8Array;       // 长度 = w * h * 4 (R,G,B,A)
  delayMs: number;        // 由 GIF graphic control extension 决定，缺省 40ms
}
export interface GifMeta {
  frames: ARGBFrame[];
  loopCount: number;      // 0 = 无限
  bgColor?: [number,number,number];
}
```

### 3. decoder.ts 核心流程

```ts
export async function decodeGif(path: string, targetCols: number, ctx: { abortSignal?: AbortSignal }): Promise<GifMeta> {
  if (ctx.abortSignal?.aborted) throw new Error("aborted");
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
  const raw = parseGif(buf);                      // header / palette / frames
  const frames: ARGBFrame[] = [];
  const canvas = new Uint8Array(raw.width * raw.height * 4);   // disposal canvas
  for (const rf of raw.frames) {
    if (ctx.abortSignal?.aborted) throw new Error("aborted");
    applyFrameToCanvas(canvas, rf);                            // disposal-aware
    const scaled = scaleNearest(canvas, raw.width, raw.height, targetCols);   // 等比缩放
    frames.push({ ...scaled, delayMs: rf.delayMs ?? 40 });
  }
  return { frames, loopCount: raw.loopCount, bgColor: raw.bgColor };
}
```

> **取消独立 AC**（AGENTS.md §9 红线代码化）：调用方传入 `parentSignal`，decoder 顶层检查；
> 解码循环每帧 abort 检查；不直接 forward 给底层 `Bun.file()`（已经 sync）。

### 4. ansi.ts — 半块字符渲染

```ts
export interface RenderOpts {
  alphaThreshold: number;       // 默认 128；< 视为透明
  trueColor: boolean;           // false → 16-color fallback
}
export function frameToAnsi(frame: ARGBFrame, opts: RenderOpts): string {
  const ESC = "\x1b";
  const sb: string[] = [];
  for (let y = 0; y < frame.height; y += 2) {
    let lastSeq = "";
    for (let x = 0; x < frame.width; x++) {
      const top = pickPx(frame, x, y);
      const bot = y + 1 < frame.height ? pickPx(frame, x, y + 1) : transparent;
      const tv = top.a >= opts.alphaThreshold;
      const bv = bot.a >= opts.alphaThreshold;
      if (tv && bv) {
        const seq = `${ESC}[38;2;${top.r};${top.g};${top.b};48;2;${bot.r};${bot.g};${bot.b}m`;
        if (seq !== lastSeq) { sb.push(seq); lastSeq = seq; }
        sb.push("\u2580");                      // ▀
      } else if (tv) {
        const seq = `${ESC}[0;38;2;${top.r};${top.g};${top.b}m`;
        if (seq !== lastSeq) { sb.push(seq); lastSeq = seq; }
        sb.push("\u2580");
      } else if (bv) {
        const seq = `${ESC}[0;38;2;${bot.r};${bot.g};${bot.b}m`;
        if (seq !== lastSeq) { sb.push(seq); lastSeq = seq; }
        sb.push("\u2584");                      // ▄
      } else {
        if (lastSeq !== "RST") { sb.push(`${ESC}[0m`); lastSeq = "RST"; }
        sb.push(" ");
      }
    }
    sb.push(`${ESC}[0m\n`);
  }
  return sb.join("");
}
```

`opts.trueColor=false` 时把 `38;2;R;G;B` 改成 `nearestAnsi8(r,g,b)` 的 4-bit 编号（用 `step-31` 既有 16-color 表）。

### 5. 缩放（等比）

```ts
function scaleNearest(src: Uint8Array, sw: number, sh: number, targetCols: number): { width: number; height: number; data: Uint8Array } {
  // 终端字符宽 ≈ 像素 × 1；半块字符意味着每 2 行像素 = 1 行字符
  // 因此「字符列数 = targetCols」对应「像素宽 = targetCols」
  const newW = targetCols;
  let newH = Math.round(sh * (newW / sw));
  if (newH % 2 !== 0) newH++;                   // 偶数化
  // nearest-neighbor 缩放
  const dst = new Uint8Array(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / newH));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / newW));
      const s = (sy * sw + sx) * 4;
      const d = (y * newW + x) * 4;
      dst[d] = src[s]; dst[d+1] = src[s+1]; dst[d+2] = src[s+2]; dst[d+3] = src[s+3];
    }
  }
  return { width: newW, height: newH, data: dst };
}
```

> 不引 sharp / jimp（≈ MB 级，AGENTS.md §8 不引隐式重依赖）。nearest-neighbor 对吉祥物像素图够用。

## 接口冻结 / 不变量

- `ARGBFrame` / `GifMeta` 字段冻结（B9 屏障）；扩展只追加可选字段。
- `decodeGif()` 必须接受 `parentSignal`，**本地 AbortController 包装**（AGENTS.md §9）。
- ANSI 字符串**纯 ASCII + 半块字符**，不引入终端依赖逃逸序列（如 OSC、DECSET）；调用方负责光标定位。
- targetCols ≤ 80 默认；超过 120 抛 warn（吉祥物变得太大不美观）。

## 验收标准

- `bun run typecheck` 通过；
- `scripts/smoke-step36.ts`：解码 `gif/2026-06-12_012827.GIF` → `frames.length > 0` && 每帧 `data.length === w*h*4`；
- 渲染首帧的 ANSI 字符串包含 `\x1b[38;2;` 序列；不包含 `\x1b[?25l`（光标控制由调用方做）；
- 解码 5 个 GIF 单文件 ≤ 800ms（warm cache 关闭情况下，本机 baseline）；
- abort：传入 pre-aborted signal → 立即抛 `aborted`，无残留 buffer；
- 单文件 ≤ 600 行（每个 ts）。

## 风险

- **GIF89a disposal method**：处理不当导致前后帧串色；smoke fixture 至少包含一个用 disposal=2（restore-bg）的 GIF。
- **LZW 实现**：自实现易出 off-by-one；step-36 spec 推荐**先**用 `omggif` 跑通流程（PR 注释）后**再**尝试自实现。如评审认为延迟 K 阶段不划算，可保留 `omggif`（明确写在 KNOWN-LIMITATIONS）。
- **真彩色降级**：16-color 模式下吉祥物会非常失真；建议保留默认 trueColor=true，并在 detectTerminal 不支持时直接走 ASCII fallback（step-37 处理）。
