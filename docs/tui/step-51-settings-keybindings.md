# Step 51 — Keybindings 设置 + 冲突检测

**Phase**: N | **依赖**: 48 | **可并行**: 49, 50 | **估时**: 3h

## 目标

让用户在 Settings → Keybindings 里**可视化**全部默认快捷键，可改、可恢复默认、可清除。
冲突（同 key 多 binding）实时检测 + 红色警告。

## 产物

```
src/screens/settingsTabs/
├── keybind.tsx
└── fieldEditors/
    └── HotkeyEditor.tsx       # 录制按键作为新值
```

## 实现要点

### 1. KeybindPanel 渲染

```tsx
// src/screens/settingsTabs/keybind.tsx
export function KeybindPanel({ highlightFieldId }: Props) {
  const all = DEFAULT_BINDINGS;
  const conflicts = useMemo(() => detectConflicts(all, loadUserBindings()), []);
  return (
    <Box flexDirection="column" paddingX={1}>
      {all.map(b => (
        <KeybindRow
          key={b.id}
          binding={b}
          conflict={conflicts.find(c => c.ids.includes(b.id))}
          highlight={b.id === highlightFieldId}
        />
      ))}
    </Box>
  );
}
```

### 2. KeybindRow

```tsx
function KeybindRow({ binding, conflict, highlight }: Props) {
  const theme = useTheme();
  const [recording, setRecording] = useState(false);
  const cur = getBinding(binding.id);
  const isCustom = cur !== binding.defaultKey;

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text bold={highlight}>{t(`keybind.${binding.id}`) || binding.description}</Text>
        {conflict ? <Text color={theme.error}>{` ⚠ ${t("settings.keybind.conflict")}`}</Text> : null}
      </Box>
      <Box>
        {recording
          ? <Text color={theme.warning}>{t("settings.keybind.press")}</Text>
          : (
            <>
              <Text color={isCustom ? theme.accent : undefined} bold={isCustom}>{cur}</Text>
              {isCustom ? <Text dimColor>{` (${t("settings.keybind.modified")})`}</Text> : null}
            </>
          )}
      </Box>
    </Box>
  );
}
```

### 3. HotkeyEditor — 按键录制

```tsx
function HotkeyEditor({ bindingId, onCommit, onCancel, onClear }: Props) {
  const theme = useTheme();
  const [captured, setCaptured] = useState<string | null>(null);
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.delete || key.backspace) { onClear(); return; }   // 清除该绑定
    const desc = describeKey(input, key);                     // step-34 既有 parser 反向工具
    if (!desc) return;
    setCaptured(desc);
  }, { isActive: true });
  if (captured) {
    return (
      <Box>
        <Text>{`${t("settings.keybind.captured")}: `}</Text>
        <Text bold color={theme.accent}>{captured}</Text>
        <Text dimColor>{`  ${t("settings.keybind.confirm")}`}</Text>
      </Box>
    );
  }
  return <Text color={theme.warning}>{t("settings.keybind.recordHint")}</Text>;
}
```

`describeKey(input, key)` 是 step-34 `parseKey` 的反向：从 Ink 的 input/key 推回 `"Ctrl+P"` 字符串形式。

### 4. 持久化

```ts
// 改动经 SettingsField.write：
{
  id: `keybind.${binding.id}`,
  category: "keybind",
  type: "hotkey",
  read: () => getBinding(binding.id),
  write: async (v) => setUserBinding(binding.id, v),
  validate: (v) => v.trim().length === 0 ? t("settings.validate.empty") : null,
}
```

但**不是**每个 binding 单独 register；KeybindPanel 直接调 setUserBinding（不走 dirty/commit），原因：
hotkey 录制是**即时**的（用户确认即录），与 toggle/select 节奏不同。

```ts
function commitHotkey(bindingId: string, captured: string) {
  const conflict = findConflict(bindingId, captured);
  if (conflict) { showConflictToast(conflict); return; }
  setUserBinding(bindingId, captured);          // 立即写盘 + 重算冲突
  // 不需进 settings.dirty —— 已 persist
}
```

对齐 MiMo：冲突会 toast 并阻止 commit，用户必须先清除旧绑定或选择其它键位。

### 5. 恢复默认 / 清除

- `Backspace` 在 KeybindRow 选中时 → setUserBinding(id, null) → 恢复 default；
- 录制窗口内 `Backspace` → 清除该绑定（`null` 持久化为「无」）；
- 设置底部加 "全部恢复" 按钮（`R` 快捷键）→ 弹确认后 setUserBinding(id, null) for all。

### 6. 冲突列表

```tsx
function ConflictsList() {
  const conflicts = detectConflicts(DEFAULT_BINDINGS, loadUserBindings());
  if (conflicts.length === 0) return null;
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.error} paddingX={1} marginTop={1}>
      <Text bold color={theme.error}>{t("settings.keybind.conflictsHeader")}</Text>
      {conflicts.map((c, i) => (
        <Text key={i}>{`${c.key}: ${c.ids.join(" + ")}`}</Text>
      ))}
    </Box>
  );
}
```

挂在 KeybindPanel 底部。

## 接口冻结 / 不变量

- `setUserBinding(id, value | null)` 是单源 mutation（与 step-34 一致）；UI 不直写 config.json keybindings；
- 清除（null）可以让 binding 完全失效（hook handler 不触发）；
- 录制按键时**只**接受 modifier+letter 组合或单 key（Tab/Enter/Esc/Function 键）；不允许录纯字符（避免 InputBox 失效）；
- 冲突默认阻止保存并 toast 说明；只有用户清除冲突后才能写入 config。
- keybindings 分组对齐 MiMo：General / Session / Navigation / Model & Provider / Prompt / Message / Panels / Companion / Advanced，分组标题走 i18n。

## 验收标准

- `bun run typecheck` 通过；
- 设置 → Keybindings → 列出 ≥ 20 项；
- 选中 palette.open → Enter 进入录制 → 按 `Ctrl+Shift+P` → confirmed → 列表显示 modified；重启后仍 modified；
- 录制时按 Backspace → 清除 binding → 列表显示 `(empty)`；Ctrl+P 不再触发 palette；
- 故意把 buddy.pet 改成 Ctrl+P → toast 冲突，config 不写入；ConflictsList 仅显示历史遗留冲突；
- `scripts/smoke-step51.ts`：setUserBinding + 读 config.json 含覆盖；setUserBinding(id, null) + 读 → 字段为 null；冲突录制不会写入 config。

## 风险

- **describeKey 不全**：Ink 5 的 key 对象不暴露所有键名（如 numpad）→ 录制失败 + warn；KNOWN-LIMITATIONS 注明。
- **录制时全局 hook 仍生效**：录制窗口内必须暂停 step-34 useKeybinding 全局监听（用 raw mode），否则按 Esc 会被全局取消捕获 → HotkeyEditor 自己 raw mode 控制。
- **chord 录制**：暂不支持录制 chord（如 `Ctrl+X L`）；仅录单组合键，KNOWN-LIMITATIONS 注明 chord 需手编 config.json。
