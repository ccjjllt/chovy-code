# Step 32 (TUI i18n) Acceptance

## 核心成果
- 实现了类似于 MiMo TUI 的多语言分层机制：`Preference` (设置中的语言选项) -> `Effective` (实际生效的语言) -> `Label` -> `Base` -> `Cache` -> `Loader`。
- 引入了 `LocalePreference` ("auto" | "zh" | "en") 和内置的 `Locale` ("zh" | "en")。
- 创建了基础多语言支持基础设施 (`src/i18n`):
  - `locales.ts` (定义类型和常量)
  - `detect.ts` (环境探测机制: 读取 `LC_ALL` / `LANG`，或者 `config.i18n.locale`)
  - `flatten.ts` (多语言词典打平与模板引擎 `{{param}}`)
  - `locales/en.ts` / `locales/zh.ts` (英文和中文完整词典定义)
  - `format.ts` (金额格式化辅助函数 `formatCost` 等)
  - `pinyin-initials.ts` (为 TUI Command Palette 准备的首字母拼音匹配工具函数，附带内置 fallback 映射)
  - `bridge.ts` (为将来的 TUI 提供 `UiI18nBridge` 上下文)
  - `index.ts` (多语言模块对外主出口，负责单例加载)

## 具体变更
- **配置系统扩展**: 在 `src/config/config.ts` 中增加了 `i18n` 层（可选的 `locale` / `costInCNY` 配置项），保留不泄漏 secret 原则。
- **命令行 `/lang`**: 增加了 `src/cli/slashCommands/lang.ts`，支持 `/lang zh`, `/lang en`, `/lang auto` 等动态切换语言操作。
- **启动自动加载**: 修改了 `src/cli/index.tsx` 中的 `resolveCtx` 调用链，在程序启动阶段等待 `setLocale()` 完成预热，随后渲染 UI。
- **组件及文案迁移**: 
  - 移除了原有的硬编码 help 文本，在对应的 `slashCommands/*.ts` 中使用了 `t("slash.*.desc")`。
  - 将 `src/cli/components/HeaderBar.tsx` 中的 hardcode 文本迁移到 `t("header.*")`，并通过 `formatCost` 处理金额显示。
- **Telemetry 集成**: `src/telemetry/events.ts` 注册了 `tui.locale.change`。

## Smoke 测试与类型检查
- 编写并执行了 `scripts/smoke-step32.ts`：
  - 断言 `zh` 和 `en` 扁平化后的字典 key 完全一致。
  - 检查不存在散落的以 `/[a-z]` 打头的未翻译 Slash 命令原串。
- 执行 `bun run typecheck` 通过，无类型泄漏或错误。

## 接下来
- TUI 基础设施搭建完毕 (Theme & i18n)，可以进入 Layout (step-33) 和 Keybindings (step-34) 环节。
