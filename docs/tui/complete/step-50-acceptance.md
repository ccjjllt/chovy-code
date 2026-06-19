# Step 50: Settings Theme & Language Acceptance

## 目标
- 完成 `settingsTabs/theme.tsx` 和 `settingsTabs/language.tsx`。
- 实现 `FieldList`，`FieldRow` 以及 `ColorEditor` / `ThemePreview` 等。
- 确保 `getTheme` / `setTheme` 和 `getLocale` / `setLocale` 与配置的持久化保持一致。
- 构建 `scripts/smoke-step50.ts` 完成验证。

## 验收结果
- **组件完成度**:
  - `FieldList`: 已完成列表光标游走和切换编辑模式状态 (`useSettingsState`, `setDirty`)
  - `ColorEditor`: 已完成带有颜色校验 `valid = errorMsg === null` 和即时预览的十六进制输入组件。
  - `ThemePreview`: 已完成动态的主题颜色块样例。
  - `theme.tsx` 和 `language.tsx`: 已成功注册所需的各个 `SettingsField` (包含 `theme.primary`, `tui.density`, `i18n.locale` 等)，并对接持久化方案（如 `saveConfigPatch` 和 `setCustomTheme`）。
- **配置持久化**: 
  - 通过 `src/config/config.ts` 中的 `saveConfigPatch` 实现。
  - `commitDirty` 会顺序遍历 `SettingsField` 并执行 `write` 钩子持久化改变。
- **Smoke Tests**: `bun run scripts/smoke-step50.ts` 已经执行并通过。验证了设置 `ChovyLight` 主题的生效，`setCustomTheme` 的部分重写和持久化，以及 `setLocale` 的更改。
- **Typecheck**: `bun run typecheck` 执行全部通过，所有类型定义严格遵守。

## 结论
Step 50 已成功验收。
