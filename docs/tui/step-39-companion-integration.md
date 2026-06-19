# Step 39 — Companion 集成主屏 + speech bubble

**Phase**: K | **依赖**: 38 | **可并行**: 41, 45 | **估时**: 3h

## 目标

把 `<CompanionHost/>` 真正挂到 REPL 主屏。InputBox 旁边显示吉祥物 + 偶尔冒一句 speech bubble。
窄终端（< 100 cols）退化成单行 face + quip。

## 产物

```
src/companion/
├── CompanionHost.tsx     # 主入口组件，挂载到 repl.tsx
├── speechBubble.tsx      # 自绘气泡（chovy-code 风格，不抄 cc-haha 锯齿）
├── quips.ts              # 状态 → i18n key 列表（随机选一句）
└── index.ts              # mountCompanion / CompanionHandle barrel
```

## 实现要点

### 1. CompanionHost 主组件

```tsx
// src/companion/CompanionHost.tsx
interface Props {
  cwd: string;
  reservedCols?: number;       // 父组件保留给吉祥物的列数
}
export function CompanionHost({ cwd, reservedCols }: Props): React.ReactElement | null {
  const caps = useTerminalCaps();
  const sm = getCompanionStateMachine();
  const [state, setState] = useState<CompanionState>(sm.current());
  const [skin] = useUserSkin();              // 默认 "default"
  const [muted] = useCompanionMuted();
  const [reaction, setReaction] = useState<string | undefined>(undefined);

  useEffect(() => sm.onChange((s) => {
    setState(s);
    // 状态转移触发 quip
    if (s === "done")  setReaction(t(pickQuip("done")));
    if (s === "error") setReaction(t(pickQuip("error")));
    if (s === "work" || s === "idle") setReaction(undefined);
  }), [sm]);

  if (muted || process.env["CHOVY_NO_COMPANION"] === "1") return null;
  if (caps.cols < 60) return <NarrowFace state={state} reaction={reaction} />;
  const gifPath = resolveGifPath(state, skin, cwd);
  return (
    <Box flexDirection="row" alignItems="flex-end" paddingX={1} flexShrink={0}>
      {reaction ? <SpeechBubble text={reaction} state={state}/> : null}
      <CompanionPlayer gifPath={gifPath} active cols={Math.min(reservedCols ?? 24, 28)} />
    </Box>
  );
}
```

`MIN_COLS_FOR_FULL_GIF = 100`：与 cc-haha 同阈值（终端经验值）；< 100 cols 走 NarrowFace。

### 2. SpeechBubble — chovy-code 风格

**与 cc-haha 完全不同的形状**（创新 #1.4 红线）：

```
┌──────────────────────┐
│  我在干活！         │
│  写完就告诉你 :)    │
└──────────────────────┘
 · · ·                       ← 三点延伸（不用 ╲╲ 锯齿）
```

```tsx
export function SpeechBubble({ text, state }: { text: string; state: CompanionState }) {
  const theme = useTheme();
  const fg = state === "error" ? theme.error : state === "done" ? theme.success : theme.accent;
  const lines = wrapByDisplayWidth(text, 30);   // 用 step-33 stringWidth
  return (
    <Box flexDirection="column" marginRight={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={fg} paddingX={1} width={34}>
        {lines.map((l, i) => <Text key={i} italic color={fg}>{l}</Text>)}
      </Box>
      <Box paddingLeft={4}>
        <Text color={fg} dimColor>· · ·</Text>
      </Box>
    </Box>
  );
}
```

气泡 8 秒后淡出（fade）：用 ref 记 startTick，超过 6 秒切到 `dimColor` 1 秒，然后清掉 reaction。

### 3. quips.ts

```ts
const QUIPS: Record<CompanionState, string[]> = {
  idle:  ["companion.bubble.idle", "companion.bubble.idle.alt1"],
  work:  ["companion.bubble.work", "companion.bubble.work.alt1"],
  think: ["companion.bubble.think"],
  done:  ["companion.bubble.done.success1", "companion.bubble.done.success2", "companion.bubble.done.success3"],
  error: ["companion.bubble.error", "companion.bubble.error.alt1"],
};
export function pickQuip(state: CompanionState): string {
  const arr = QUIPS[state];
  return arr[Math.floor(Math.random() * arr.length)]!;
}
```

i18n keys 在 step-32 字典里准备好；中文示例：
- `companion.bubble.work` = "我在干活！"
- `companion.bubble.done.success1` = "搞定啦！"
- `companion.bubble.error` = "刚刚出错了，要不要看看？"

### 4. mountCompanion + CompanionHandle

```ts
// src/companion/index.ts
export interface CompanionHandle {
  setState(s: CompanionState): void;
  pet(): void;
  mute(b: boolean): void;
  skin(name: string): void;
  dispose(): void;
}
export function mountCompanion(opts: { cwd: string; muted?: boolean }): CompanionHandle {
  const sm = getCompanionStateMachine();
  if (opts.muted) setUserCompanionMuted(true);
  return {
    setState: (s) => sm.setState(s),
    pet: () => companionBus.emit({ type: "pet" }),
    mute: (b) => setUserCompanionMuted(b),
    skin: (n) => setUserSkin(n),
    dispose: () => sm.dispose(),
  };
}
```

REPL 在挂载时：

```tsx
const companionRef = useRef<CompanionHandle>();
useEffect(() => {
  companionRef.current = mountCompanion({ cwd: process.cwd(), muted: false });
  return () => companionRef.current?.dispose();
}, []);
```

### 5. NarrowFace（< 60 cols 兜底）

```tsx
function NarrowFace({ state, reaction }: { state: CompanionState; reaction?: string }) {
  const theme = useTheme();
  const face = ASCII_FALLBACK[state][0];      // step-37 既有
  return (
    <Box paddingX={1} alignSelf="flex-end">
      <Text color={theme.primary} bold>{face}</Text>
      {reaction ? <Text italic color={theme.accent}> {reaction.slice(0, 24)}</Text> : null}
    </Box>
  );
}
```

## 接口冻结 / 不变量

- `CompanionHandle` 5 方法冻结（B9）；扩展只追加。
- CompanionHost 是 React 组件**纯 UI**：所有 mutation（state / skin / mute）走 handle 或 stateMachine 单例，**不**直接 setState。
- 气泡 fade 时长 8s 写常量，不进 config。
- < 60 cols 强制 NarrowFace；用户**不能**关此降级（保证窄终端可用）。

## 验收标准

- `bun run typecheck` 通过；
- 运行 `chovy chat` → 看到吉祥物 + 偶尔冒泡（`done` 状态）；
- resize 终端到 50 cols → 立即变 NarrowFace；resize 回 120 cols → 恢复完整 GIF；
- `Ctrl+C` 退出 → 无残留 setTimeout / setInterval（用 leaked-handles 工具或手测）；
- `CHOVY_NO_COMPANION=1` → 完全不显示，不解 GIF；
- `scripts/smoke-step39.ts`：mount + 立即 dispose → 资源全部释放（state machine + cache loader）。

## 风险

- **InputBox 列宽计算**：吉祥物占用列数 + 气泡列数变化时，InputBox `wrap` 不应抖动；用 `companionReservedColumns()` helper（见 step-39 实现）每渲染计算一次，不在 InputBox 内嵌。
- **气泡 fade 抖动**：fade 1 秒切换 dimColor 时不要 re-mount，只 setState；React.memo 包 SpeechBubble。
- **多语言文本超宽**：英文 quip 可能比中文长 2 倍 → wrapByDisplayWidth 兜底，超 30 列自动换行（最多 3 行）。
