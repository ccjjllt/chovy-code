# Step 49 — General + Provider + Model 设置分类

**Phase**: N | **依赖**: 48 | **可并行**: 50, 51 | **估时**: 4h

## 目标

实现 SettingsScreen 的 General、Provider、Model 三个分类的 fields，对齐 MiMo 的 General / Providers / Models 信息架构，但只规划 TUI 可实现项。

- General：release notes / tips / reasoning summaries / tool blocks expanded / permission mode / never-ask / terminal title / diff wrap / toast 行为；
- Provider：当前 provider / API key 状态（不显示明文）/ provider source / custom base URL（已有 provider 支持时）；
- Model：当前 model / favorites / recent / variants / 可见模型 / reasoning effort（provider 支持时）。

## 产物

```
src/screens/settingsTabs/
├── general.tsx
├── provider.tsx
├── model.tsx
└── fieldEditors/
    ├── TextEditor.tsx
    ├── ToggleEditor.tsx
    ├── SelectEditor.tsx
    └── SecretStatus.tsx     # 只显示 configured/missing，永不显示 key
```

## 实现要点

### 1. General fields

```ts
// src/screens/settingsTabs/general.tsx
const FIELDS: SettingsField[] = [
  {
    id: "general.releaseNotes",
    label: "settings.field.releaseNotes",
    category: "general",
    section: "updates",
    type: "toggle",
    read: () => String(loadConfig().general?.releaseNotes ?? true),
    write: (v) => saveConfigPatch({ general: { releaseNotes: v === "true" } }),
  },
  {
    id: "general.showTips",
    label: "settings.field.showTips",
    category: "general",
    section: "onboarding",
    type: "toggle",
    read: () => String(loadConfig().general?.showTips ?? true),
    write: (v) => saveConfigPatch({ general: { showTips: v === "true" } }),
  },
  {
    id: "general.showReasoningSummaries",
    label: "settings.field.showReasoningSummaries",
    category: "general",
    section: "messages",
    type: "toggle",
    read: () => String(loadConfig().general?.showReasoningSummaries ?? true),
    write: (v) => saveConfigPatch({ general: { showReasoningSummaries: v === "true" } }),
  },
  {
    id: "general.shellToolPartsExpanded",
    label: "settings.field.shellToolPartsExpanded",
    category: "general",
    section: "messages",
    type: "toggle",
    read: () => String(loadConfig().general?.shellToolPartsExpanded ?? false),
    write: (v) => saveConfigPatch({ general: { shellToolPartsExpanded: v === "true" } }),
  },
  {
    id: "general.editToolPartsExpanded",
    label: "settings.field.editToolPartsExpanded",
    category: "general",
    section: "messages",
    type: "toggle",
    read: () => String(loadConfig().general?.editToolPartsExpanded ?? false),
    write: (v) => saveConfigPatch({ general: { editToolPartsExpanded: v === "true" } }),
  },
  {
    id: "general.permissionMode",
    label: "settings.field.permissionMode",
    category: "general",
    section: "behavior",
    type: "select",
    read: () => loadConfig().permissions?.mode ?? "default",
    write: (v) => saveConfigPatch({ permissions: { mode: v } }),
    options: [
      { value: "default", label: "default" },
      { value: "ask", label: "ask" },
      { value: "accept-edits", label: "accept-edits" },
    ],
  },
  {
    id: "general.neverAskQuestions",
    label: "settings.field.neverAskQuestions",
    category: "general",
    section: "behavior",
    type: "toggle",
    read: () => String(loadConfig().general?.neverAskQuestions ?? false),
    write: (v) => saveConfigPatch({ general: { neverAskQuestions: v === "true" } }),
  },
  {
    id: "general.terminalTitle",
    label: "settings.field.terminalTitle",
    category: "general",
    section: "terminal",
    type: "toggle",
    read: () => String(loadConfig().tui?.terminalTitle ?? true),
    write: (v) => saveConfigPatch({ tui: { terminalTitle: v === "true" } }),
  },
  {
    id: "general.diffWrapMode",
    label: "settings.field.diffWrapMode",
    category: "general",
    section: "messages",
    type: "select",
    read: () => loadConfig().tui?.diffWrapMode ?? "word",
    write: (v) => saveConfigPatch({ tui: { diffWrapMode: v } }),
    options: [
      { value: "word", label: t("settings.option.wordWrap") },
      { value: "none", label: t("settings.option.noWrap") },
    ],
  },
  {
    id: "general.toastLevel",
    label: "settings.field.toastLevel",
    category: "general",
    section: "notifications",
    type: "select",
    read: () => loadConfig().tui?.toastLevel ?? "normal",
    write: (v) => saveConfigPatch({ tui: { toastLevel: v } }),
    options: [
      { value: "quiet", label: t("settings.option.quiet") },
      { value: "normal", label: t("settings.option.normal") },
      { value: "verbose", label: t("settings.option.verbose") },
    ],
  },
];
for (const f of FIELDS) registerSettingsField(f);

export function GeneralPanel({ highlightFieldId }: Props) {
  return <FieldList category="general" highlightFieldId={highlightFieldId} fields={FIELDS} />;
}
```

`saveConfigPatch` 是新增的 helper：deep merge 到 `~/.chovy/config.json`，**不**触碰 secrets。

### 2. Provider fields

```ts
// src/screens/settingsTabs/provider.tsx
const PROVIDER_FIELDS: SettingsField[] = [
  {
    id: "provider.current",
    label: "settings.field.provider",
    category: "provider",
    type: "select",
    read: () => loadConfig().provider ?? "openai",
    write: async (v) => saveConfigPatch({ provider: v }),
    options: () => listProviders().map(p => ({ value: p.info.id, label: p.info.name })),
  },
  {
    id: "provider.apiKey",
    label: "settings.field.apiKey",
    category: "provider",
    type: "secret",
    read: () => hasSecret(loadConfig().provider) ? "configured" : "missing",
    write: async (v) => writeSecret(loadConfig().provider, v),  // 只写 secrets/<provider>
    validate: (v) => v.trim().length === 0 ? t("settings.validate.secretEmpty") : null,
  },
  {
    id: "provider.source",
    label: "settings.field.providerSource",
    category: "provider",
    type: "readonly",
    read: () => providerSource(loadConfig().provider),  // env / secrets / config / custom
    write: async () => {},
  },
  {
    id: "provider.baseUrl",
    label: "settings.field.providerBaseUrl",
    category: "provider",
    type: "text",
    read: () => loadConfig().providers?.[loadConfig().provider]?.baseUrl ?? "",
    write: async (v) => saveConfigPatch({ providers: { [loadConfig().provider]: { baseUrl: v || undefined } } }),
    validate: (v) => v === "" || /^https?:\/\//.test(v) ? null : t("settings.validate.url"),
  },
];
for (const f of PROVIDER_FIELDS) registerSettingsField(f);
```

`provider.apiKey.read()` 永远返回 `"configured" | "missing"`——**不**返回明文（AGENTS.md §26 配置入口不变量）。
SecretStatus 编辑器在用户输入新 key 时直接送到 write，UI 立即清空缓存（不存 dirty）。

### 2.1 Model fields

```ts
// src/screens/settingsTabs/model.tsx
const MODEL_FIELDS: SettingsField[] = [
  {
    id: "model.current",
    label: "settings.field.model",
    category: "model",
    type: "select",
    read: () => loadConfig().model ?? defaultModelFor(loadConfig().provider),
    write: async (v) => saveConfigPatch({ model: v }),
    options: () => listModelsForCurrentProvider()
      .filter(m => isModelVisible(loadConfig().provider, m))
      .map(m => ({ value: m, label: m })),
  },
  {
    id: "model.visible",
    label: "settings.field.modelVisibility",
    category: "model",
    type: "select",
    read: () => "open",
    write: async () => {},  // 打开 ModelVisibilityEditor，多选项由编辑器内部写 config.models.hidden
    options: [{ value: "open", label: t("settings.action.configure") }],
  },
  {
    id: "model.favorite",
    label: "settings.field.favoriteModels",
    category: "model",
    type: "select",
    read: () => "open",
    write: async () => {},  // 打开 FavoriteModelsEditor，供 Ctrl+P 推荐 / cycleRecent 使用
    options: [{ value: "open", label: t("settings.action.configure") }],
  },
  {
    id: "model.recent",
    label: "settings.field.recentModels",
    category: "model",
    type: "readonly",
    read: () => listRecentModels().slice(0, 10).join(", ") || t("settings.value.empty"),
    write: async () => {},
  },
  {
    id: "model.variant",
    label: "settings.field.modelVariant",
    category: "model",
    type: "select",
    read: () => loadConfig().modelOptions?.variant ?? "default",
    write: async (v) => saveConfigPatch({ modelOptions: { variant: v } }),
    options: () => listVariantsForCurrentModel().map(v => ({ value: v, label: v })),
  },
  {
    id: "model.reasoningEffort",
    label: "settings.field.reasoningEffort",
    category: "model",
    type: "select",
    read: () => loadConfig().modelOptions?.reasoningEffort ?? "default",
    write: async (v) => saveConfigPatch({ modelOptions: { reasoningEffort: v } }),
    options: [
      { value: "default", label: "default" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
  },
];
for (const f of MODEL_FIELDS) registerSettingsField(f);
```

Model visibility 对齐 MiMo 的 Models tab，但用 TUI 多选列表实现；隐藏的模型不出现在 `/model`、Ctrl+P `model.switch`、Settings `model.current` 选择器里。

### 3. FieldList 通用渲染

```tsx
function FieldList({ category, fields, highlightFieldId }: Props) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const items = fields;
  // 接 cursor 滚动 + Enter 进入编辑模式
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((f, i) => (
        <FieldRow key={f.id} field={f} selected={i === cursor} highlight={f.id === highlightFieldId} />
      ))}
    </Box>
  );
}
```

### 4. FieldRow

```tsx
function FieldRow({ field, selected, highlight }: Props) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.read());
  // 进入 / 退出编辑：
  useKeybinding("focus.next", () => { if (selected && !editing) setEditing(true); }, { isActive: selected && !editing });

  if (editing) {
    return <Editor field={field} value={value} onChange={setValue} onCommit={() => {
      setDirty(field.id, value); setEditing(false);
    }} onCancel={() => { setValue(field.read()); setEditing(false); }} />;
  }
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text inverse={selected} bold={highlight}>{field.label}</Text>
      <FieldValue field={field} value={value} />
    </Box>
  );
}
```

### 5. SecretStatus

```tsx
function SecretStatus({ status }: { status: "configured"|"missing" }) {
  const theme = useTheme();
  return status === "configured"
    ? <Text color={theme.success}>● {t("settings.secret.configured")}</Text>
    : <Text color={theme.error}>○ {t("settings.secret.missing")}</Text>;
}
```

进入编辑后用 raw mode 接受 key 输入（**不回显**，仅显示 `*` 个数），与 ConfigWizard 的 secret 输入一致。

### 6. saveConfigPatch helper

```ts
// src/config/patch.ts
export async function saveConfigPatch(partial: Partial<ChovyConfig>): Promise<void> {
  const cur = loadConfig();
  const merged = deepMerge(cur, partial);
  // 与 §26 一致：禁止 apiKey/secret 字段进 config.json
  stripSecretFields(merged);
  await safeFs.write(configPath(), JSON.stringify(merged, null, 2));
  invalidateConfigCache();
}
```

## 接口冻结 / 不变量

- General/Provider/Model fields 在模块顶层 `for...registerSettingsField` **一次性**注册（与 tools registry 同纪律）；
- secret read 永远返回状态字符串，永不返回明文；
- saveConfigPatch 必须 stripSecretFields 防回写（防御性）；
- options() 返回的列表运行时计算（provider 切换后 model 列表更新）。
- MiMo 的声音 / 桌面字体 / 系统通知项不进 chovy TUI；对应能力改成 toastLevel、terminal title、theme/density 等终端可实现项。

## 验收标准

- `bun run typecheck` 通过；
- 设置 → General → showReasoningSummaries toggle off → MessageList 默认折叠 reasoning summary；
- 设置 → General → neverAskQuestions / terminalTitle / diffWrapMode 写入 config 后，Ctrl+P 对应命令状态同步变化；
- 设置 → Provider → 切 provider → model options 同步更新；
- 设置 → Model → favorite / recent / variant 正常展示；隐藏某模型 → `/model` 与 Ctrl+P model.switch 不再显示该模型；
- 设置 → Provider → apiKey 输入 → 写到 `~/.chovy/secrets/<provider>`；config.json 不包含 apiKey 字段；
- `scripts/smoke-step49.ts`：toggle 字段 + commit → config.json 含新值 + secrets 目录无变化。

## 风险

- **API key 输入回显**：必须 raw mode 不回显；KNOWN-LIMITATIONS 标 SSH 终端可能仍显（用户责任）。
- **provider 切换连锁**：切 provider 后 model 字段当前值可能不在新列表中 → 自动选默认 model + warn。
- **deepMerge 数组陷阱**：数组用 replace 而非 concat（避免 keybindings 数组重复）。
