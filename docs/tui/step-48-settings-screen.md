# Step 48 — SettingsScreen 骨架（mimo 风格左右双栏）

**Phase**: N | **依赖**: B8 (J 屏障) | **可并行**: 36, 41, 45 | **估时**: 4h

## 目标

`Ctrl+,` 打开设置界面（图 4 mimo 风格）：左栏分类列表 + 右栏字段编辑器。
本步只做**骨架与导航**，具体 4 个分类 fields 在 step-49/50/51；与 ConfigWizard 复用在 step-52。

## 产物

```
src/screens/
├── settings.tsx         # SettingsScreen 主屏 + open/close API
├── settingsTabs/
│   ├── index.ts         # CATEGORY_LIST 与 CATEGORY_KEYS
│   ├── general.tsx      # step-49 占位（本步空 panel）
│   ├── provider.tsx     # step-49
│   ├── theme.tsx        # step-50
│   ├── language.tsx     # step-50
│   └── keybind.tsx      # step-51
└── state.ts             # useSettingsState（open/category/dirtyFields）

src/cli/slashCommands/settings.ts   # /settings command
```

## 实现要点

### 1. 状态管理

```ts
// src/screens/state.ts
export interface SettingsState {
  open: boolean;
  category: SettingsCategory;        // "general" | "provider" | "theme" | "language" | "keybind"
  highlightFieldId?: string;          // 跳转到指定 field 时滚动 + 高亮
  dirty: Record<string, string>;      // fieldId → newValue（保存时一次性 commit）
}
export type SettingsCategory = "general" | "provider" | "theme" | "language" | "keybind";

const _store = createStore<SettingsState>({
  open: false, category: "general", dirty: {},
});
export function useSettingsState();
export function openSettings(fieldId?: string);
export function closeSettings(opts?: { discard?: boolean });
export function setCategory(c: SettingsCategory);
export function setDirty(fieldId: string, value: string);
export function commitDirty();   // 调用 SettingsField.write（step-49+ 填）
```

### 2. SettingsScreen 主组件

```tsx
// src/screens/settings.tsx
export function SettingsScreen({ ctx }: { ctx: ReplCtx }): React.ReactElement | null {
  const { open, category, dirty, highlightFieldId } = useSettingsState();
  if (!open) return null;
  const theme = useTheme();
  const caps = useTerminalCaps();

  useKeybinding("settings.cancel", () => closeSettings({ discard: true }), { isActive: open });
  useKeybinding("settings.save",   () => commitAndClose(),                  { isActive: open });
  useKeybinding("focus.next",      () => cycleSettingsFocus("forward"),     { isActive: open });

  return (
    <Box flexDirection="column" borderStyle={theme.borderStyle} borderColor={theme.accent}
         paddingX={1} width={Math.min(caps.cols - 4, 100)} height={Math.min(caps.rows - 4, 32)}>
      <SettingsHeader dirty={Object.keys(dirty).length} />
      <SplitPane
        ratio={0.28}
        left={<CategoryList category={category} onPick={setCategory} />}
        right={<CategoryPanel category={category} highlightFieldId={highlightFieldId} />}
      />
      <SettingsFooter />
    </Box>
  );
}
```

### 3. SettingsHeader

```
设置                                          {dirty} 项未保存 · esc 取消 · ^S 保存
```

```tsx
function SettingsHeader({ dirty }: { dirty: number }) {
  const theme = useTheme();
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text bold color={theme.primary}>{t("settings.title")}</Text>
      <Box>
        {dirty > 0 ? <Text color={theme.warning}>{t("settings.dirty", { n: dirty })} · </Text> : null}
        <Text dimColor>{`${getBinding("settings.cancel")} 取消 · ${getBinding("settings.save")} 保存`}</Text>
      </Box>
    </Box>
  );
}
```

### 4. CategoryList

```tsx
const CATEGORY_LIST: SettingsCategory[] = ["general","provider","theme","language","keybind"];

function CategoryList({ category, onPick }: { category: SettingsCategory; onPick: (c: SettingsCategory) => void }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingRight={1}>
      {CATEGORY_LIST.map(c => (
        <Box key={c} paddingY={0}>
          <Text inverse={c === category} bold={c === category} color={c === category ? theme.accent : undefined}>
            {` ${t(`settings.category.${c}`)} `}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
```

`useInput` 在 SettingsScreen 顶层处理 ↑↓ 移动 category index。

### 5. CategoryPanel — 路由到具体 tab

```tsx
function CategoryPanel({ category, highlightFieldId }: { ... }) {
  switch (category) {
    case "general":  return <GeneralPanel highlightFieldId={highlightFieldId} />;
    case "provider": return <ProviderPanel highlightFieldId={highlightFieldId} />;
    case "theme":    return <ThemePanel highlightFieldId={highlightFieldId} />;
    case "language": return <LanguagePanel highlightFieldId={highlightFieldId} />;
    case "keybind":  return <KeybindPanel highlightFieldId={highlightFieldId} />;
  }
}
```

各 Panel 在 step-49/50/51 实现；本步**先各放一个空 box**：

```tsx
function GeneralPanel(_props: { highlightFieldId?: string }) {
  return <Text dimColor>常规设置（step-49 实现）</Text>;
}
```

### 6. SettingsField 接口（B10 冻结）

见 architecture.md §3 B10：

```ts
export interface SettingsField {
  id: string;                                // "theme.name"
  label: string;                             // i18n 标签
  category: SettingsCategory;
  type: "text"|"select"|"toggle"|"hotkey"|"secret";
  read(): string;
  write(v: string): Promise<void>;
  options?: { value: string; label: string }[];
  validate?(v: string): string | null;
}
export function listSettingsFields(): SettingsField[];
export function registerSettingsField(f: SettingsField): void;
```

step-48 只声明接口；具体注册在 step-49/50/51 完成。

### 7. /settings slash + Ctrl+,

```ts
// src/cli/slashCommands/settings.ts
export const settingsHandler: SlashHandler = (args, ctx) => {
  const fieldId = args.trim() || undefined;
  ctx.openSettings?.(fieldId);     // step-44 已加 ctx 字段
};
```

`Ctrl+,` 在 step-34 注册了 `settings.open`：

```tsx
// src/cli/repl.tsx
useKeybinding("settings.open", () => openSettings(), { isActive: !busy });
```

### 8. 焦点环（CategoryList ↔ FieldList ↔ SettingsFooter）

SettingsScreen 内部用三态局部 focus（不进全局焦点环）：`"category" | "field" | "footer"`，
`Tab` 顺时针。step-57 的全局焦点环把 `settings` 视作"独立 modality"——打开期间禁用其它 panel 焦点。

## 接口冻结 / 不变量

- `SettingsCategory` 联合扩展只追加；不替换既有 5 个；
- `SettingsField` 字段冻结（B10）；
- `commitDirty()` **必须**全部成功后才 close；某 field write 抛错 → 标该 field error 但保持 panel 打开；
- 设置 / 命令面板互斥：openSettings 时若 palette 在开 → 自动关 palette；反之亦然（step-57 协调）。

## 验收标准

- `bun run typecheck` 通过；
- 启动 chovy → Ctrl+, 打开 SettingsScreen；左栏 5 类，右栏占位文本；
- ↑↓ 切类；Esc 关闭丢弃 dirty；Ctrl+S 保存（本步无 field 故 no-op）；
- 同时只能开一个 overlay：palette 开时按 Ctrl+, → 自动关 palette；
- `scripts/smoke-step48.ts`：openSettings("theme.name") → state.category="theme"; state.highlightFieldId="theme.name"。

## 风险

- **focus 与 palette 互斥**：双方各自 useState，靠协调函数（settings open → setPaletteOpen(false)）；step-57 给规整化抽象。
- **Ctrl+, 终端兼容**：旧 ConHost 可能吞 → KNOWN-LIMITATIONS 写明，可改 `Ctrl+;`。
- **Esc 二义**：palette 内 Esc 关 palette；settings 内 Esc 取消编辑。useKeybinding scope 区分。
