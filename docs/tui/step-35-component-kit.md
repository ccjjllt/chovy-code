# Step 35 — TUI 基础组件库（Panel / Card / Badge / Spinner / Divider / List）

**Phase**: J | **依赖**: 31, 32, 33 | **可并行**: 34 | **估时**: 3h

## 目标

提供一套主题化、i18n-aware 的 Ink 基础组件，后续 K/L/M/N/O 阶段所有屏幕都用它，**禁止**直接写裸 `<Box borderStyle=…>`。

## 产物

```
src/tui/kit/
├── Panel.tsx        # 圆角边框 + 标题 + 内容；主题色边框
├── Card.tsx         # 无边框 + 内边距 + bg accent 浅
├── Badge.tsx        # 内联小标签（success/warning/error/info/accent）
├── Spinner.tsx      # 帧切换 spinner，用 theme.spinnerFrames
├── Divider.tsx      # 横线（细/粗，labeled 可选）
├── List.tsx         # 通用列表（item + 当前项高亮）
├── HotkeyHint.tsx   # 显示如 "Ctrl+P"，自动 i18n 化 modifier
├── Spacer.tsx       # 等价 <Box flexGrow={1}/>
└── index.ts         # barrel export + useTheme/useLocale 兜底
```

## 实现要点

### 1. Panel

```tsx
interface PanelProps {
  title?: string;                  // 已经过 t() 的字符串
  titleRight?: string;             // 右上角文本（如 "esc"）
  borderColor?: string;            // 默认 theme.primary
  focused?: boolean;               // true → borderColor=theme.accent + bold
  minWidth?: number; minHeight?: number;
  children: React.ReactNode;
}
```

实现：

```tsx
export function Panel({ title, titleRight, borderColor, focused, minWidth, minHeight, children }: PanelProps) {
  const theme = useTheme();
  const caps = useTerminalCaps();
  const color = focused ? theme.accent : (borderColor ?? theme.primary);
  return (
    <Box flexDirection="column" borderStyle={theme.borderStyle} borderColor={color}
         paddingX={1} minWidth={minWidth} minHeight={minHeight}>
      {(title || titleRight) ? (
        <Box justifyContent="space-between">
          {title ? <Text bold color={color}>{title}</Text> : <Spacer/>}
          {titleRight ? <Text dimColor>{titleRight}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}
```

### 2. Badge

```tsx
type BadgeVariant = "success"|"warning"|"error"|"info"|"accent"|"muted";
<Badge variant="accent">推荐</Badge>
```

实现把 variant 映射到 `theme.success` / `theme.warning` 等；用 `inverse` 反相显示文字。

### 3. Spinner（与 step-56 micro-animations 共享）

```tsx
<Spinner label={t("msg.busy")} />
```

```tsx
export function Spinner({ label, intervalMs = 100 }: { label?: string; intervalMs?: number }) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % theme.spinnerFrames.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, theme.spinnerFrames.length]);
  return (
    <Box>
      <Text color={theme.accent}>{theme.spinnerFrames[frame]}</Text>
      {label ? <Text> {label}</Text> : null}
    </Box>
  );
}
```

### 4. List（通用，命令面板 + 设置都用）

```tsx
interface ListProps<T> {
  items: T[];
  selectedIndex: number;
  renderItem: (item: T, opts: { selected: boolean; index: number }) => React.ReactNode;
  emptyHint?: string;            // 空列表时显示的 i18n 文本
  maxVisible?: number;           // 默认 10；超出滚动窗口
}
```

滚动窗口：维护 `[start, start + maxVisible)`，当 `selectedIndex` 越界自动滚动；用 `▲/▼` 提示更多项。

### 5. HotkeyHint

```tsx
<HotkeyHint id="palette.open" />   →   "Ctrl+P"
<HotkeyHint k="Ctrl+Shift+L" />    →   "Ctrl+Shift+L"
```

i18n 把 modifier 名字本地化：locale=`zh` 下 `Ctrl` 仍是 "Ctrl"（保留约定俗成），不译；只有 `Esc` / `Enter` 等会替换为「ESC / 回车」。i18n key：`hotkey.modifier.ctrl` 等，默认中文保持原文。

## 接口冻结 / 不变量

- 所有组件必须**通过 hook 拿主题**（`useTheme()`），不接受裸 `color` prop（除非显式覆盖）；
- props ≤ 8 个（AGENTS.md §8 沿用）；
- 组件 = pure function + memoized；不挂全局 listener；
- **不**默认导出（barrel 命名导出）；
- 全部组件可在 `CHOVY_NO_TUI=1` 下退化到纯 Text / Box 无边框模式（minimum-viable，本步先留 todo）。

## 验收标准

- `bun run typecheck` 通过；
- 单元（`scripts/smoke-step35.ts`）：用 ink-testing-library mount Panel + Spinner，断言渲染含主题色 hex；
- 跑 `chovy chat` 启动屏样式无回退（边框颜色为紫色）；
- 切 `/theme set ChovyMonochrome` → 所有 Panel borderColor 变白色 / muted；
- 全部组件单文件 ≤ 120 行。

## 风险

- **Ink testing 依赖**：避免引 `ink-testing-library` 重依赖；smoke 用更简的 mount + manual snapshot。
- **theme 切换重渲染**：`useTheme` 内部用 `useSyncExternalStore` 订阅 `onThemeChange`；组件树多时单次 setTheme 重渲染量大 → 仍可接受（< 50ms）。
- **List 大数据**：> 500 项时 setState 卡顿；`maxVisible` 默认 10 + 虚拟滚动避免。
