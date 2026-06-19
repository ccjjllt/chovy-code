# Step 48 — SettingsScreen 骨架（MiMo 风格左右双栏）

**Phase**: N | **依赖**: B8 (J 屏障) | **可并行**: 36, 41, 46, 53, 54, 55 | **估时**: 4h

## 目标

`Ctrl+,` 打开设置界面（参考 MiMo 风格）：左栏分类列表 + 右栏字段编辑器。
本步只做**骨架与导航**，具体 7 个分类 fields 在 step-49/50/51；与 ConfigWizard 复用在 step-52。

## 产物

```
src/screens/
├── settings.tsx         # SettingsScreen 主屏 + open/close API
├── settingsTabs/
│   ├── index.ts         # CATEGORY_LIST 与 CATEGORY_KEYS
│   ├── general.tsx      # step-49 占位（本步空 panel）
│   ├── provider.tsx     # step-49
│   ├── model.tsx        # step-49
│   ├── theme.tsx        # step-50
│   ├── language.tsx     # step-50
│   ├── keybind.tsx      # step-51
│   └── advanced.tsx     # step-49/50 占位 + step-58 诊断
└── state.ts             # useSettingsState（open/category/dirtyFields）

src/cli/slashCommands/settings.ts   # /settings command
```

## 实现要点

### 1. 状态管理

```ts
// src/screens/state.ts
export interface SettingsState {
  open: boolean;
  category: SettingsCategory;        // "general" | "provider" | "model" | "theme" | "language" | "keybind" | "advanced"
  highlightFieldId?: string;          // 跳转到指定 field 时滚动 + 高亮
  query: string;                       // / 搜索设置项
  dirty: Record<string, string>;      // fieldId → newValue（保存时一次性 commit）
}
export type SettingsCategory = "general" | "provider" | "model" | "theme" | "language" | "keybind" | "advanced";

const _store = createStore<SettingsState>({
  open: false, category: "general", query: "", dirty: {},
});
export function useSettingsState();
export function openSettings(fieldId?: string);
export function closeSettings(opts?: { discard?: boolean });
export function setCategory(c: SettingsCategory);
export function setSettingsQuery(q: string);
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
const CATEGORY_LIST: SettingsCategory[] = ["general","provider","model","theme","language","keybind","advanced"];

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
    case "model":    return <ModelPanel highlightFieldId={highlightFieldId} />;
    case "theme":    return <ThemePanel highlightFieldId={highlightFieldId} />;
    case "language": return <LanguagePanel highlightFieldId={highlightFieldId} />;
    case "keybind":  return <KeybindPanel highlightFieldId={highlightFieldId} />;
    case "advanced": return <AdvancedPanel highlightFieldId={highlightFieldId} />;
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
  label: string;                             // i18n key；渲染时 t(label)，不保存已翻译文本
  category: SettingsCategory;
  section?: string;                          // MiMo 式分组，如 appearance / notifications
  description?: string;                      // i18n key；渲染时 t(description)
  type: "text"|"select"|"toggle"|"hotkey"|"secret"|"color"|"readonly";
  read(): string;
  write(v: string): Promise<void>;
  options?: { value: string; label: string }[] | (() => { value: string; label: string }[]);
  validate?(v: string): string | null;
  restartRequired?: boolean;
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

SettingsScreen 内部用四态局部 focus（不进全局焦点环）：`"category" | "search" | "field" | "footer"`，
`Tab` 顺时针。step-57 的全局焦点环把 `settings` 视作"独立 modality"——打开期间禁用其它 panel 焦点。

### 9. MiMo 对齐范围

Settings 的信息架构对齐 MiMo，但只保留 TUI 可实现项：

| chovy 分类 | 对齐 MiMo 来源 | 本阶段字段来源 |
|---|---|---|
| General | Desktop / General | release notes、tips、reasoning/tool block 展开、permission mode、never-ask、terminal title、diff wrap、toast 行为 |
| Provider | Server / Providers | provider 选择、API key 状态、custom base URL（如已有 provider 支持） |
| Model | Server / Models | model 选择、favorites、recent、variants、可见模型、reasoning effort（provider 支持时） |
| Theme | Appearance | theme、primary/accent/bg/fg/borderStyle、density、animations、companion display |
| Language | Language | locale preference/effective、response language、cost currency |
| Keybind | Shortcuts | 搜索、录制、冲突阻止、恢复默认 |
| Advanced | Advanced / Updates | TUI diagnostics、cache 清理、env fallback 只读状态、Windows perf 选项 |

## 接口冻结 / 不变量

- `SettingsCategory` 联合扩展只追加；B10 前固定为 7 类；
- `SettingsField` 字段冻结（B10）；
- `SettingsField.label` / `description` 保存 i18n key，不保存 `t()` 结果；切换语言后 SettingsScreen 与 Ctrl+P settings command 必须即时重渲染；
- `commitDirty()` **必须**全部成功后才 close；某 field write 抛错 → 标该 field error 但保持 panel 打开；
- 设置 / 命令面板互斥：openSettings 时若 palette 在开 → 自动关 palette；反之亦然（step-57 协调）。

## 验收标准

- `bun run typecheck` 通过；
- 启动 chovy → Ctrl+, 打开 SettingsScreen；左栏 7 类，右栏占位文本；
- ↑↓ 切类；Esc 关闭丢弃 dirty；Ctrl+S 保存（本步无 field 故 no-op）；
- 同时只能开一个 overlay：palette 开时按 Ctrl+, → 自动关 palette；
- `scripts/smoke-step48.ts`：openSettings("theme.name") → state.category="theme"; state.highlightFieldId="theme.name"；openSettings("model.visible") → category="model"。
- B10 前 `listSettingsFields()` 必须覆盖 7 类且字段总数 ≥30；每个 field 都有 zh/en label、description（可选但推荐）、read/write/validate 语义。
- step-44 落地后，每个 SettingsField 都能注册为 Ctrl+P 的 `settings.*` 命令；只存在 SettingsScreen 里、不能搜索跳转的字段不算完成。

## 风险

- **focus 与 palette 互斥**：双方各自 useState，靠协调函数（settings open → setPaletteOpen(false)）；step-57 给规整化抽象。
- **Ctrl+, 终端兼容**：旧 ConHost 可能吞 → KNOWN-LIMITATIONS 写明，可改 `Ctrl+;`。
- **Esc 二义**：palette 内 Esc 关 palette；settings 内 Esc 取消编辑。useKeybinding scope 区分。
