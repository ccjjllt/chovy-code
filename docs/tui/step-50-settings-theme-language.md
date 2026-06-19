# Step 50 — Theme/Appearance + Language 设置

**Phase**: N | **依赖**: 48 | **可并行**: 49, 51 | **估时**: 4h

## 目标

实现 SettingsScreen 的 Theme 与 Language 两个分类。
Theme 提供内置主题选择 + 自定义 primary/accent/bg/fg 色 + appearance 行为；Language 提供 zh/en/auto 切换、回复语言与数字货币显示偏好。`zh-CN` / `en-US` 只作为旧配置兼容 alias 读取，新写入统一保存 `zh` / `en` / `auto`。

## 产物

```
src/screens/settingsTabs/
├── theme.tsx
├── language.tsx
└── fieldEditors/
    ├── ColorEditor.tsx     # hex 输入 + 实时预览
    └── ThemePreview.tsx    # 当前主题 swatch（4 色 + Border 样例）
```

## 实现要点

### 1. Theme fields

```ts
// src/screens/settingsTabs/theme.tsx
const FIELDS: SettingsField[] = [
  {
    id: "theme.name",
    label: "settings.field.theme",
    category: "theme",
    type: "select",
    read: () => getTheme().name,
    write: async (v) => { setTheme(v); },
    options: () => listThemes().map(t => ({ value: t.name, label: t.name })),
  },
  {
    id: "theme.primary",
    label: "settings.field.theme.primary",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.primary ?? getTheme().primary,
    write: async (v) => {
      saveConfigPatch({ theme: { custom: { primary: v } } });
      setTheme(getTheme().name);   // re-resolve 以应用 custom
    },
    validate: (v) => /^#[0-9a-fA-F]{6}$/.test(v) ? null : t("settings.validate.hex"),
  },
  {
    id: "theme.accent",
    label: "settings.field.theme.accent",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.accent ?? getTheme().accent,
    write: async (v) => {
      saveConfigPatch({ theme: { custom: { accent: v } } });
      setTheme(getTheme().name);
    },
    validate: (v) => /^#[0-9a-fA-F]{6}$/.test(v) ? null : t("settings.validate.hex"),
  },
  {
    id: "theme.bg",
    label: "settings.field.theme.bg",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.bg ?? getTheme().bg,
    write: async (v) => {
      saveConfigPatch({ theme: { custom: { bg: v } } });
      setTheme(getTheme().name);
    },
    validate: (v) => v === "default" || /^#[0-9a-fA-F]{6}$/.test(v) ? null : t("settings.validate.hexOrDefault"),
  },
  {
    id: "theme.fg",
    label: "settings.field.theme.fg",
    category: "theme",
    type: "color",
    read: () => loadConfig().theme?.custom?.fg ?? getTheme().fg,
    write: async (v) => {
      saveConfigPatch({ theme: { custom: { fg: v } } });
      setTheme(getTheme().name);
    },
    validate: (v) => /^#[0-9a-fA-F]{6}$/.test(v) ? null : t("settings.validate.hex"),
  },
  {
    id: "theme.borderStyle",
    label: "settings.field.theme.border",
    category: "theme",
    type: "select",
    read: () => loadConfig().theme?.custom?.borderStyle ?? getTheme().borderStyle,
    write: async (v) => {
      saveConfigPatch({ theme: { custom: { borderStyle: v as Theme["borderStyle"] } } });
      setTheme(getTheme().name);
    },
    options: () => [
      { value: "round",  label: "round (默认)" },
      { value: "single", label: "single" },
      { value: "double", label: "double" },
      { value: "bold",   label: "bold" },
    ],
  },
  {
    id: "tui.density",
    label: "settings.field.density",
    category: "theme",
    section: "appearance",
    type: "select",
    read: () => loadConfig().tui?.density ?? "comfortable",
    write: async (v) => saveConfigPatch({ tui: { density: v } }),
    options: [
      { value: "compact", label: t("settings.option.compact") },
      { value: "comfortable", label: t("settings.option.comfortable") },
    ],
  },
  {
    id: "tui.animations",
    label: "settings.field.animations",
    category: "theme",
    section: "appearance",
    type: "toggle",
    read: () => String(loadConfig().tui?.animations ?? true),
    write: async (v) => saveConfigPatch({ tui: { animations: v === "true" } }),
  },
  {
    id: "companion.visible",
    label: "settings.field.companionVisible",
    category: "theme",
    section: "companion",
    type: "toggle",
    read: () => String(loadConfig().companion?.visible ?? true),
    write: async (v) => saveConfigPatch({ companion: { visible: v === "true" } }),
  },
  {
    id: "companion.size",
    label: "settings.field.companionSize",
    category: "theme",
    section: "companion",
    type: "select",
    read: () => loadConfig().companion?.size ?? "auto",
    write: async (v) => saveConfigPatch({ companion: { size: v } }),
    options: [
      { value: "auto", label: "auto" },
      { value: "compact", label: "compact" },
      { value: "small", label: "small" },
    ],
  },
];
```

### 2. ThemePanel — 含实时预览

```tsx
export function ThemePanel({ highlightFieldId }: Props) {
  return (
    <Box flexDirection="column">
      <FieldList category="theme" highlightFieldId={highlightFieldId} fields={FIELDS} />
      <Box marginTop={1} borderStyle="single">
        <ThemePreview />
      </Box>
    </Box>
  );
}
```

### 3. ThemePreview

```tsx
function ThemePreview() {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>{t("settings.theme.preview")}</Text>
      <Box>
        <Text color={theme.primary}>■ primary  </Text>
        <Text color={theme.accent}>■ accent  </Text>
        <Text color={theme.success}>■ success  </Text>
        <Text color={theme.error}>■ error</Text>
      </Box>
      <Box borderStyle={theme.borderStyle} borderColor={theme.primary} paddingX={1} marginTop={1}>
        <Text color={theme.fg}>{t("settings.theme.previewText")}</Text>
      </Box>
    </Box>
  );
}
```

write 一次主题 → setTheme 触发 onThemeChange → useTheme 重新订阅 → ThemePreview 立即更新。
注意：ThemePreview 只预览 UI token；吉祥物 GIF 不参与主题预览，不被 primary/accent 调色。

### 4. ColorEditor（hex 输入）

```tsx
function ColorEditor({ value, onChange, onCommit, onCancel }: Props) {
  const theme = useTheme();
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text>{`> `}</Text>
      <SimpleInput value={value} onChange={onChange} maxLength={7} />
      <Box marginLeft={2}>
        <Text color={valid ? value : theme.error}>{valid ? "■ 预览" : t("settings.validate.hex")}</Text>
      </Box>
    </Box>
  );
}
```

### 5. Language fields

```ts
// src/screens/settingsTabs/language.tsx
const FIELDS: SettingsField[] = [
  {
    id: "i18n.locale",
    label: "settings.field.locale",
    category: "language",
    type: "select",
    read: () => getLocalePreference(),
    write: async (v) => setLocale(v as LocalePreference),
    options: () => [
      { value: "auto", label: `${t("settings.option.auto")} (${labelLocale(getLocale())})` },
      { value: "zh", label: labelLocale("zh") },
      { value: "en", label: labelLocale("en") },
    ],
  },
  {
    id: "i18n.responseLanguage",
    label: "settings.field.responseLanguage",
    category: "language",
    type: "select",
    read: () => loadConfig().i18n?.responseLanguage ?? "auto",
    write: async (v) => saveConfigPatch({ i18n: { responseLanguage: v } }),
    options: [
      { value: "auto", label: t("settings.option.auto") },
      { value: "zh", label: labelLocale("zh") },
      { value: "en", label: labelLocale("en") },
    ],
  },
  {
    id: "i18n.costInCNY",
    label: "settings.field.costInCNY",
    category: "language",
    type: "toggle",
    read: () => String(loadConfig().i18n?.costInCNY ?? false),
    write: async (v) => saveConfigPatch({ i18n: { costInCNY: v === "true" } }),
  },
];
```

`i18n.locale` 保存的是 LocalePreference（`zh` / `en` / `auto`）；UI 显示使用 effective `getLocale()`。读取旧配置时 `zh-CN` / `en-US` 先经 `normalizeLocale()` 归一化。

### 6. setTheme / setLocale 是同步的（step-31/32 既有）

设置面板 commit 时 await write → 写盘 → 触发 onChange → React 重渲染。
**不需要**关闭面板再生效——主题切换实时可见（视觉反馈很好）。
locale 切换后整个 SettingsScreen 文本立即变中/英。

## 接口冻结 / 不变量

- hex 验证统一在 SettingsField.validate 中实现；ColorEditor 不重写校验；
- ThemePreview 是只读组件，不调 setTheme；切换主题入口仅 SettingsField.write；
- 自定义 primary/accent 与内置 theme.name 共存：name 决定基色，custom 字段覆盖（step-31 resolveTheme）；
- 默认主题必须“紫多蓝少”：primary 用于主边框 / 标题 / 选中，accent 只用于辅助焦点；
- `companion.size` 不暴露任意列数，只能选 `auto|compact|small`，确保吉祥物不会过大；
- locale 切换**不**重启 chovy，立即生效。

## 验收标准

- `bun run typecheck` 通过；
- 设置 → Theme → 切到 ChovyHighContrast → 整个 UI 立即变；
- 设置 → Theme → primary 输入 `#A855F7` → ThemePreview 立即变紫；保存后重启仍然生效；
- 输入非法 hex 如 `red` → 校验提示红色；commit 被拒；
- 设置 → Language → 切 `en` → 设置面板自身文本立即变英文；切 auto 且 LANG=zh_CN → effective locale 为 `zh`；
- 设置 → Theme → companion.size 选 compact → 主屏吉祥物变小且重启保持；
- `scripts/smoke-step50.ts`：write theme.primary `#123456` → loadConfig().theme.custom.primary === "#123456"。

## 风险

- **真彩色不支持**：用户输入 `#A855F7` 但终端 16 色 → 显示降级到最近 16 色；ThemePreview 文字提示 "low color terminal"。
- **borderStyle 切换闪烁**：Ink 边框 style 变化触发整树重绘；只有 commit 时才生效（dirty 期间预览只在 ThemePreview 内部 box 显示样例）。
- **locale 切换中途**：commit 期间用户已经看到中文/英文混合 1 帧（dirty 状态用 dict 还没切完）；切完一帧后稳定，可接受。
