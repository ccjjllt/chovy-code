# Chovy Code Developer Guide

## TUI 模块开发

- 主题：`src/theme/`（紫蓝默认 + 自定义）
- i18n：`src/i18n/`（MiMo 式 `LocalePreference` / base fallback / loader cache / `{{ param }}` template；内置 zh / en）
- 键位：`src/keybindings/`（注册 + 解析 + chord）
- 布局原语：`src/tui/primitives/`
- 组件库：`src/tui/kit/`
- 吉祥物：`src/companion/`（GIF 解码 + ANSI 半块渲染）
- 命令面板：`src/palette/`（含中文模糊搜索）
- 屏幕：`src/screens/`（welcome / settings）

详见 `docs/tui/architecture.md`。

## 新增 i18n key

每加一个 key 必须在 `src/i18n/locales/zh.ts` + `en.ts` 同步；
CI smoke 检验 key 集合等价。

## 新增主题

加在 `src/theme/tokens.ts` 的 `BUILT_INS` 数组；命名 `Chovy<Name>`。

## 新增 palette 命令

调 `registerCommand(...)` 或在 `src/cli/commandSources.ts` 增加来源适配；slash / skills / plugins / workflows 自动进入同一 command store（step-43/44）。
