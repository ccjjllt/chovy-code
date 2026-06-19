# Step 37 — 帧缓存 + Companion 播放器组件

**Phase**: K | **依赖**: 36 | **估时**: 3h

## 目标

让吉祥物**从第二次启动开始 < 200ms** 显示出来：把 step-36 解码出的 ANSI 帧序列**写到本地缓存**
（`~/.chovy/cache/companion/<gif-hash>/<frame>.ansi`），并提供一个 Ink 组件 `<CompanionPlayer/>` 按 `delayMs`
切帧渲染。

## 产物

```
src/companion/
├── cache.ts          # 读 / 写 / 校验帧缓存
├── player.tsx        # <CompanionPlayer gifPath frameSource onReady />
└── ascii-fallback.ts # 终端不支持真彩色 / unicode 时的 ASCII 兜底（5 个状态各一）
```

## 实现要点

### 1. 缓存路径与 hash

```ts
// src/companion/cache.ts
export function cacheDirFor(gifPath: string): string {
  const hash = sha1(`${absolute(gifPath)}|${stat(gifPath).mtimeMs}|v1`).slice(0, 12);
  return path.join(chovyHome(), "cache", "companion", hash);
}
```

`v1` 是 schema 版本号；解码 / 渲染算法变化时 bump → 自动失效旧缓存。

### 2. 缓存文件格式

每个 GIF 对应一个目录：

```
~/.chovy/cache/companion/<hash>/
├── meta.json      # { width: 64, height: 48, frames: [{ delayMs: 40 }, ...], v: 1 }
└── frame-000.ansi
    frame-001.ansi
    ...
```

> ANSI 字符串直接写文件（已包含半块字符 + ANSI 序列）；读取时 `Bun.file().text()` 一次性拿。

### 3. 加载流程

```ts
// src/companion/cache.ts
export async function loadFramesCached(gifPath: string, targetCols: number, signal?: AbortSignal): Promise<{ frames: { ansi: string; delayMs: number }[]; widthCols: number; heightRows: number }> {
  const dir = cacheDirFor(gifPath);
  const metaPath = path.join(dir, "meta.json");
  if (await safeFs.exists(metaPath)) {
    const meta = JSON.parse(await safeFs.read(metaPath));
    if (meta.v === 1 && meta.targetCols === targetCols) {
      const frames = await Promise.all(meta.frames.map(async (m, i) => ({
        ansi: await safeFs.read(path.join(dir, `frame-${String(i).padStart(3, "0")}.ansi`)),
        delayMs: m.delayMs,
      })));
      return { frames, widthCols: meta.widthCols, heightRows: meta.heightRows };
    }
  }
  // miss → 解码 + 写盘
  const decoded = await decodeGif(gifPath, targetCols, { abortSignal: signal });
  const ansi = decoded.frames.map(f => frameToAnsi(f, { alphaThreshold: 128, trueColor: detectTerminal().trueColor }));
  await persistCache(dir, decoded, ansi, targetCols);
  return {
    frames: decoded.frames.map((f, i) => ({ ansi: ansi[i]!, delayMs: f.delayMs })),
    widthCols: decoded.frames[0]!.width,
    heightRows: decoded.frames[0]!.height / 2,
  };
}
```

### 4. CompanionPlayer 组件

```tsx
interface CompanionPlayerProps {
  gifPath: string;                     // 当前状态对应的 GIF
  active: boolean;                     // 暂停 / 隐藏（脱焦时停止帧切换省 CPU）
  cols: number;                        // 渲染宽度
  onReady?: () => void;
}
export function CompanionPlayer({ gifPath, active, cols, onReady }: CompanionPlayerProps) {
  const [frames, setFrames] = useState<{ ansi: string; delayMs: number }[] | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    loadFramesCached(gifPath, cols, ac.signal).then(r => {
      setFrames(r.frames); setIdx(0); onReady?.();
    }).catch(err => {
      if (ac.signal.aborted) return;
      logger.warn(`[companion] decode failed: ${err}`);
      // 静默降级到 ASCII fallback：调用方观察 frames=null + setError
    });
    return () => ac.abort();
  }, [gifPath, cols]);

  useEffect(() => {
    if (!active || !frames || frames.length === 0) return;
    const cur = frames[idx]!;
    const t = setTimeout(() => setIdx(i => (i + 1) % frames.length), Math.max(80, cur.delayMs));
    return () => clearTimeout(t);
  }, [active, frames, idx]);

  if (!frames) return <AsciiFallback state="loading" />;
  return <Box><Text>{frames[idx]!.ansi}</Text></Box>;
}
```

`Math.max(80, cur.delayMs)` 限制最大 12fps（AGENTS.md §22 step-22 同模式：再快 Ink 跟不上）。

### 5. ASCII fallback

```ts
// src/companion/ascii-fallback.ts
export const FALLBACKS: Record<CompanionState, string[]> = {
  idle:   ["( - . - )", "( - . - )", "( = . = )"],
  work:   ["( o _ o )", "( O _ O )", "( o _ O )"],
  think:  ["(?_?)",     "(?_? )",   "( ?_?)"],
  done:   ["( ^ . ^ )", "( ^ _ ^ )"],
  error:  ["( x _ x )", "( X _ X )"],
};
```

`AsciiFallback` 组件按 500ms 切帧；`CHOVY_NO_COMPANION=1` 也走它（只显示首帧）。

## 接口冻结 / 不变量

- 缓存路径 = `~/.chovy/cache/companion/<hash>/`；hash 包含 mtime → GIF 改了自动重解。
- `loadFramesCached` 失败必须返回**降级**结果或抛——**不**让 player 一直空白阻塞 UI。
- 帧切换 `setTimeout` 必须在 `useEffect` cleanup 内 `clearTimeout`，组件卸载零泄漏。
- `active=false` 时**不**跑帧切换 setTimeout（CPU 0%）。

## 验收标准

- `bun run typecheck` 通过；
- `scripts/smoke-step37.ts`：第一次 loadFramesCached → 写盘；第二次 < 50ms 命中缓存（diff timestamp）；
- 跑 chovy → 吉祥物 1s 内出现且会动；按 Ctrl+C 退出无未释放定时器；
- 改 `gif/*.GIF` 文件 → cache 失效，重解码；
- `CHOVY_NO_COMPANION=1` 启动 → 显示 ASCII fallback，不解码 GIF。

## 风险

- **`safeFs` 写入二进制 ANSI**：ANSI 字符串内含 ESC（0x1B）；safeFs.write 默认 UTF-8 是兼容的（ESC 是合法 ASCII）。但要避免 readFile 时被 BOM 处理逻辑加 BOM；缓存文件不写 BOM。
- **多实例并发解码**：两个 chovy 进程同时首次启动同一 GIF → 两个进程都写盘；用「写到 tmp + rename」避免半写文件。
- **目录爆炸**：`~/.chovy/cache/companion/` 长期不清理；step-58 加 LRU 清理（保留最近 20 个 hash）。
