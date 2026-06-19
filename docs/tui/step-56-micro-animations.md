# Step 56 — Micro-animations（spinner / fade / slide）

**Phase**: O | **依赖**: 55 | **估时**: 3h | **创新**: SMOOTH-3.2

## 目标

为关键状态过渡加入轻量动画：

1. **Spinner** 已在 step-35 实现，本步引入到 StatusLine + Companion loading；
2. **Fade-in / fade-out** 用于 toast / overlay 出现消失；
3. **Slide-up** 用于 SettingsScreen / CommandPalette 弹出；
4. 全部动画**可一键关闭**（`config.tui.animations: false` 或 `CHOVY_NO_ANIM=1`）；
5. 不引动画库；用 setInterval + 帧序列。

## 产物

```
src/tui/animations/
├── useFadeIn.ts          # tick → opacity（dimColor 模拟）
├── useSlideUp.ts         # tick → row offset（marginTop 调整）
├── useTypewriter.ts      # 逐字显示（welcome greet 用）
└── tokens.ts             # 帧时长常量
```

## 实现要点

### 1. 动画开关

```ts
// src/tui/animations/tokens.ts
export const ANIM_ENABLED = (() => {
  if (process.env["CHOVY_NO_ANIM"] === "1") return false;
  const cfg = loadConfig();
  return cfg.tui?.animations !== false;     // 默认 true
})();
export const FADE_FRAMES = 6;
export const FADE_FRAME_MS = 50;
export const SLIDE_FRAMES = 5;
export const SLIDE_FRAME_MS = 32;
```

### 2. useFadeIn

```ts
export function useFadeIn(active: boolean): { dim: boolean } {
  if (!ANIM_ENABLED) return { dim: false };
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setTick(0); return; }
    const id = setInterval(() => setTick(t => Math.min(t + 1, FADE_FRAMES)), FADE_FRAME_MS);
    return () => clearInterval(id);
  }, [active]);
  // 前 3 帧 dim，后 3 帧 normal
  return { dim: tick < FADE_FRAMES / 2 };
}
```

> Ink 不支持真透明度；用 `dimColor` 切换近似 fade。前半段 dim 后半段 normal —— 用户感觉是 "渐显"。

### 3. useSlideUp

```ts
export function useSlideUp(active: boolean, lines: number): { offset: number } {
  if (!ANIM_ENABLED) return { offset: 0 };
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setTick(0); return; }
    const id = setInterval(() => setTick(t => Math.min(t + 1, SLIDE_FRAMES)), SLIDE_FRAME_MS);
    return () => clearInterval(id);
  }, [active]);
  // tick 0..5 → offset 5..0
  return { offset: Math.max(0, lines - Math.round(lines * tick / SLIDE_FRAMES)) };
}
```

CommandPalette / SettingsScreen 用：

```tsx
const { offset } = useSlideUp(open, 3);
return <Box marginTop={offset}>{...}</Box>;
```

5 帧 × 32ms ≈ 160ms 完成滑入。

### 4. useTypewriter（仅 Welcome greet 用）

```ts
export function useTypewriter(text: string, charPerTick = 2, intervalMs = 40): string {
  if (!ANIM_ENABLED) return text;
  const [shown, setShown] = useState("");
  useEffect(() => {
    setShown("");
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(text.length, i + charPerTick);
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, intervalMs);
    return () => clearInterval(id);
  }, [text, charPerTick, intervalMs]);
  return shown;
}
```

WelcomeMascotColumn 的 "欢迎回来！" 用 typewriter；用户每次启动有"小惊喜"但很短（5 字 × 40ms ≈ 200ms 完成）。

### 5. 接入点（最小入侵）

| 组件 | 动画 |
|---|---|
| Toast 出现 | useFadeIn |
| CommandPalette 出现 | useSlideUp(3) |
| SettingsScreen 出现 | useSlideUp(5) |
| Welcome greet | useTypewriter |
| StatusLine spinner | step-35 既有 Spinner |
| CompanionPlayer 解码中 | step-35 Spinner with `t("companion.loading")` |

### 6. SMOOTH-3.2 不变量

- 任何动画**总时长 ≤ 250ms**（避免成为新瓶颈）；
- 动画期间用户输入**不**被吞（InputBox 仍 active）；
- 动画**不**干扰 React reconcile：用 useState 计数 + useMemo 缓存终态；
- 关闭动画时所有 hook 立即返回终态值（无延迟）。

## 接口冻结 / 不变量

- 帧时长常量写在 tokens.ts，**不**进 config（避免用户调成 1000ms 卡顿）；
- 整体开关用 `config.tui.animations` 与 `CHOVY_NO_ANIM=1`，env 优先 config；
- 动画 hook 都是**纯 client-side useEffect**，不触发 telemetry / fs / network。

## 验收标准

- `bun run typecheck` 通过；
- 启动 chovy → "欢迎回来！" 字符逐个出现（typewriter）；
- Ctrl+P 打开 → CommandPalette 略向上滑入；
- showToast → toast 先 dim 再 normal（fade-in）；
- `CHOVY_NO_ANIM=1` 启动 → 全部动画消失，立即终态显示；
- `scripts/smoke-step56.ts`：模拟 ANIM_ENABLED=false → 所有 hook 立即返回终态；
- 100 条消息 + 流式输出 + 同时 toast 弹出 → 不掉帧（视觉接近 60fps）。

## 风险

- **Windows ConHost 闪烁**：动画 + 高频 setState 会让 ConHost 比 Windows Terminal 闪；用 `CHOVY_NO_ANIM=1` 兜底；step-58 进一步处理。
- **动画期间组件 unmount**：setTimeout/Interval 必须 cleanup；hook 都已写 cleanup。
- **typewriter 与 i18n 切换**：切语言期间 typewriter 重启 → 用户视觉上看到二次打字；可接受。
