# Step 49 — General + Provider 设置分类

**Phase**: N | **依赖**: 48 | **可并行**: 50, 51 | **估时**: 3h

## 目标

实现 SettingsScreen 的 General 与 Provider 两个分类的 fields。

- General：companionMuted / animations / costInCNY / autoPalette；
- Provider：当前 provider / model / API key 状态（不显示明文）/ 可用 provider 列表。

## 产物

```
src/screens/settingsTabs/
├── general.tsx
├── provider.tsx
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
    id: "general.companionMuted",
    label: t("settings.field.companionMuted"),
    category: "general",
    type: "toggle",
    read: () => String(loadConfig().companion?.muted ?? false),
    write: (v) => saveConfigPatch({ companion: { muted: v === "true" } }),
  },
  {
    id: "general.animations",
    label: t("settings.field.animations"),
    category: "general",
    type: "toggle",
    read: () => String(loadConfig().tui?.animations ?? true),
    write: (v) => saveConfigPatch({ tui: { animations: v === "true" } }),
  },
  {
    id: "general.costInCNY",
    label: t("settings.field.costInCNY"),
    category: "general",
    type: "toggle",
    read: () => String(loadConfig().i18n?.costInCNY ?? false),
    write: (v) => saveConfigPatch({ i18n: { costInCNY: v === "true" } }),
  },
  {
    id: "general.autoPalette",
    label: t("settings.field.autoPalette"),
    category: "general",
    type: "toggle",
    read: () => String(loadConfig().tui?.autoOpenPalette ?? false),
    write: (v) => saveConfigPatch({ tui: { autoOpenPalette: v === "true" } }),
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
    label: t("settings.field.provider"),
    category: "provider",
    type: "select",
    read: () => loadConfig().provider ?? "openai",
    write: async (v) => saveConfigPatch({ provider: v }),
    options: () => listProviders().map(p => ({ value: p.info.id, label: p.info.name })),
  },
  {
    id: "provider.model",
    label: t("settings.field.model"),
    category: "provider",
    type: "select",
    read: () => loadConfig().model ?? defaultModelFor(loadConfig().provider),
    write: async (v) => saveConfigPatch({ model: v }),
    options: () => listModelsForCurrentProvider().map(m => ({ value: m, label: m })),
  },
  {
    id: "provider.apiKey",
    label: t("settings.field.apiKey"),
    category: "provider",
    type: "secret",
    read: () => hasSecret(loadConfig().provider) ? "configured" : "missing",
    write: async (v) => writeSecret(loadConfig().provider, v),  // 只写 secrets/<provider>
    validate: (v) => v.trim().length === 0 ? t("settings.validate.secretEmpty") : null,
  },
];
for (const f of PROVIDER_FIELDS) registerSettingsField(f);
```

`provider.apiKey.read()` 永远返回 `"configured" | "missing"`——**不**返回明文（AGENTS.md §26 配置入口不变量）。
SecretStatus 编辑器在用户输入新 key 时直接送到 write，UI 立即清空缓存（不存 dirty）。

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

- General/Provider fields 在模块顶层 `for...registerSettingsField` **一次性**注册（与 tools registry 同纪律）；
- secret read 永远返回状态字符串，永不返回明文；
- saveConfigPatch 必须 stripSecretFields 防回写（防御性）；
- options() 返回的列表运行时计算（provider 切换后 model 列表更新）。

## 验收标准

- `bun run typecheck` 通过；
- 设置 → General → companionMuted toggle on → 关闭 → 启动 chovy → 吉祥物隐藏；
- 设置 → Provider → 切 provider → model options 同步更新；
- 设置 → Provider → apiKey 输入 → 写到 `~/.chovy/secrets/<provider>`；config.json 不包含 apiKey 字段；
- `scripts/smoke-step49.ts`：toggle 字段 + commit → config.json 含新值 + secrets 目录无变化。

## 风险

- **API key 输入回显**：必须 raw mode 不回显；KNOWN-LIMITATIONS 标 SSH 终端可能仍显（用户责任）。
- **provider 切换连锁**：切 provider 后 model 字段当前值可能不在新列表中 → 自动选默认 model + warn。
- **deepMerge 数组陷阱**：数组用 replace 而非 concat（避免 keybindings 数组重复）。
