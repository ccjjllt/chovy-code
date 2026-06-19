# Step 41 — CommandPalette 骨架（Ctrl+P + overlay + 焦点）

**Phase**: L | **依赖**: B8 (J 屏障) | **可并行**: 36, 45, 48 | **估时**: 4h | **创新**: PALETTE-CN

## 目标

`Ctrl+P` 打开命令面板 overlay。面板布局 = 标题 + 搜索框 + 分组列表 + 快捷键列。Esc 关闭。
本步只做**骨架与焦点**，搜索逻辑在 step-42、命令注册在 step-43、集成在 step-44。

重要边界：step-41 的任何 sample / placeholder command **不得**计入 `commandEquivalents`。本步验收只证明 cc-haha 式高密度操作容器已经能打开、聚焦、滚动、关闭；命令丰富度必须等 step-43/44 与 `command-skill-coverage.md` 验收。

## 产物

```
src/palette/
├── index.tsx          # CommandPalette overlay 主组件
├── PaletteHeader.tsx  # 标题 + esc 提示
├── PaletteInput.tsx   # 搜索输入框
├── PaletteList.tsx    # 分组列表（用 step-35 List 组件）
├── PaletteRow.tsx     # 单条命令（label + hotkey 右对齐）
└── state.ts           # usePaletteState（open/query/selectedIndex）
```

## 实现要点

### 1. 状态管理

```ts
// src/palette/state.ts
export interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;       // 在过滤后的扁平列表里的位置
}
const _store = createStore<PaletteState>({ open: false, query: "", selectedIndex: 0 });
export function usePaletteState();
export function openPalette();
export function closePalette();
export function setPaletteQuery(q: string);
export function movePaletteCursor(dir: -1 | 1);
```

`createStore` 同 `cli/state/swarmStore.ts` 模式（自实现 ≤ 60 行 redux-lite + useSyncExternalStore）。

### 2. 主组件 CommandPalette

```tsx
// src/palette/index.tsx
export function CommandPalette({ ctx }: { ctx: ReplCtx }) {
  const { open, query, selectedIndex } = usePaletteState();
  if (!open) return null;
  if (process.env["CHOVY_NO_PALETTE"] === "1") return <InlinePaletteFallback ctx={ctx}/>;

  // 拿 step-43 注册中心 + step-42 模糊搜索（本步只允许 sample data，不计入覆盖）
  const grouped = useMemo(() => groupAndFilter(getCommands(ctx), query), [query]);
  const flat = useMemo(() => flatten(grouped), [grouped]);

  // step-34 keybindings：palette scope
  useKeybinding("palette.up",    () => movePaletteCursor(-1), { isActive: open });
  useKeybinding("palette.down",  () => movePaletteCursor(1),  { isActive: open });
  useKeybinding("palette.exec",  () => execAt(flat, selectedIndex, ctx), { isActive: open });
  useKeybinding("palette.close", () => closePalette(), { isActive: open });

  const theme = useTheme();
  const caps = useTerminalCaps();
  const width = Math.min(caps.cols - 4, 80);

  return (
    <Box flexDirection="column"
         borderStyle={theme.borderStyle} borderColor={theme.accent}
         paddingX={1} width={width} height={Math.min(caps.rows - 4, 24)}>
      <PaletteHeader />
      <PaletteInput value={query} onChange={setPaletteQuery} />
      <Box flexDirection="column" flexGrow={1}>
        <PaletteList grouped={grouped} selectedIndex={selectedIndex} />
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>↑↓ 选择 · Enter 执行 · Esc 关闭</Text>
        <Text dimColor>{`${flat.length} 项`}</Text>
      </Box>
    </Box>
  );
}
```

### 3. PaletteHeader

```tsx
export function PaletteHeader() {
  const theme = useTheme();
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text bold color={theme.primary}>{t("palette.title")}</Text>
      <Text dimColor>{t("palette.scope.commands")}</Text>
    </Box>
  );
}
```

标题只放标题与范围提示；Esc / Enter / ↑↓ 等键位提示统一放 footer hotkey bar，避免照搬 MiMo 的标题右上 Esc 布局。

### 4. PaletteInput

```tsx
export function PaletteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const theme = useTheme();
  // 用既有 InputBox 简化版：单行、不支持斜杠命令、自带 placeholder
  return (
    <Box marginBottom={1}>
      <Text color={theme.accent}>{">"}</Text>
      <Box marginLeft={1}>
        <SimpleInput value={value} onChange={onChange} placeholder={t("palette.search.placeholder")} />
      </Box>
    </Box>
  );
}
```

`SimpleInput` 是个 ~60 行的最小受控输入（不复用 InputBox，避免 history / 多行复杂度）。

### 5. PaletteList + Row（本步 sample 数据）

```tsx
// sample 实现：直接展示 grouped；step-43 注册命令后才有真实数据
export function PaletteList({ grouped, selectedIndex }: { grouped: Group[]; selectedIndex: number }) {
  const theme = useTheme();
  let cursor = 0;
  return (
    <Box flexDirection="column">
      {grouped.map((g, gi) => (
        <Box key={gi} flexDirection="column" marginTop={gi === 0 ? 0 : 1}>
          <Text bold color={theme.primary}>{t(`palette.section.${g.id}`)}</Text>
          {g.items.map(item => {
            const isSel = cursor === selectedIndex;
            cursor += 1;
            return <PaletteRow key={item.id} item={item} selected={isSel} />;
          })}
        </Box>
      ))}
    </Box>
  );
}
```

### 6. PaletteRow

```tsx
export function PaletteRow({ item, selected }: { item: PaletteCommand; selected: boolean }) {
  const theme = useTheme();
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text inverse={selected} color={selected ? theme.accent : undefined}>{item.label()}</Text>
      {item.hotkey ? <Text dimColor>{item.hotkey}</Text> : null}
    </Box>
  );
}
```

`inverse=selected` 实现高亮；step-42 会在 label 上叠加搜索匹配高亮。

### 6.1 cc-haha 式操作密度，但不复刻 UI

本步的视觉/操作骨架要接近 cc-haha 的“命令很多但仍可扫读”的密度，而不是做稀疏欢迎页：

- 行高保持 1 行；单条命令只显示 label + 可选描述 hint + hotkey，不使用卡片。
- 分组标题短、可折叠空间小；空 query 先推荐 / MRU，再按 group 展开。
- hotkey 右对齐，disabled 原因在描述位显示，不弹二级说明页。
- footer 统一显示 `↑↓` / `Enter` / `Esc` / `Tab`，不把快捷键提示散落到标题右上。
- 面板最大 80 列、24 行；窄屏走 inline fallback，不全屏 takeover。
- 颜色使用 ChovyDefault 紫色主高亮、蓝色辅助焦点；不复制 MiMo 橙色，也不复制 cc-haha 的边框和 buddy 视觉。

### 7. 全局集成（minimal）

```tsx
// src/cli/repl.tsx
useKeybinding("palette.open", () => openPalette(), { isActive: !busy });
// 渲染：
{paletteOpen ? <CommandPalette ctx={ctx} /> : null}
```

`paletteOpen` 来源 `usePaletteState().open`；REPL 主体用 `displayNone={paletteOpen}`-like 处理（保留 InputBox 不卸载，但 visually hidden 让 overlay 完整显示）。

### 8. CHOVY_NO_PALETTE fallback

`InlinePaletteFallback` 在 REPL 输入 `> ` 后显示一行内联建议（取前 5 项），用 `Tab` 选择 `Enter` 执行。
保证旧 ConHost 不闪烁也能用命令系统。

## 接口冻结 / 不变量

- `PaletteState` 字段冻结（`open`/`query`/`selectedIndex`）；扩展只追加。
- 同时只能开一个 overlay：palette 与 settings 互斥（Settings 打开时 palette open=false）—— 由 step-57 全局焦点管理。
- 不在 palette 内做长 I/O / 网络；命令的 `run()` 调用方负责（fire-and-forget 关闭 palette 后跑）。

## 验收标准

- `bun run typecheck` 通过；
- chovy 启动 → Ctrl+P 打开 overlay，Esc 关闭；面板边框是 theme.accent 色；
- ↑↓ 高亮在分组间正确切换；查询为空时 flat=全部命令；
- `CHOVY_NO_PALETTE=1` → 启动 chovy + Ctrl+P → 显示 inline fallback；
- `scripts/smoke-step41.ts`：openPalette() → state.open=true，setPaletteQuery("a") → query 同步，closePalette → 全部归零。
- `scripts/smoke-step41.ts` 不输出也不校验 `commandEquivalents`；如需要 sample command，只能标记 `source="sample"` 并在 step-43 前删除或隐藏。

## 风险

- **Ink 5 全屏 overlay 闪烁**：旧 ConHost 上 paletteOpen 切换会重绘整个 REPL；用 `useMemo` 稳定 grouped + Row 用 React.memo 减少 reconciliation。
- **InputBox 输入态丢失**：palette 打开时 InputBox 不能 unmount（用户希望 Esc 后回到原来的输入）；用 conditional render 控制 visibility 而非 mount。
- **窄终端**：palette overlay 可能比终端高/宽 → 用 step-33 Constrain 限制 max；< 60 cols 走 fallback。
