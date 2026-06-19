# Step 49 完成报告：Settings General / Provider / Model

## 1. 目标达成情况
- **目标**：实现 SettingsScreen 的 General、Provider、Model 三个分类的 fields，对齐 MiMo 的信息架构。
- **状态**：✅ 已完成

## 2. 核心交付物
- **`src/screens/settingsTabs/general.tsx`**: 实现了通用设置项（General Panel），通过 `loadConfig()` 动态加载。
- **`src/screens/settingsTabs/provider.tsx`**: 实现了供应商面板（Provider Panel），展示并管理当前使用的 Provider、API Key、配置来源（env/secrets/missing）以及 baseUrl。
- **`src/screens/settingsTabs/model.tsx`**: 实现了模型配置面板（Model Panel），支持选择模型、近期模型展示等。
- **`src/screens/settingsTabs/components.tsx`** & **`fieldEditors/*.tsx`**:
  - 构建了底层表单组件（FieldList, FieldRow）。
  - 实现了 `TextEditor`、`ToggleEditor`、`SelectEditor` 编辑器。
  - 特别实现了 `SecretStatus` 组件，在用户输入密钥时**不回显**（仅显示 `*` 号），并且绕过 `dirty` 状态，直接触发 `writeSecret` 写入持久化存储。
- **`src/config/config.ts`**:
  - 扩展了 `ChovyConfig` 的 Schema 定义，补充了 `general`、`tui`、`providers`、`modelOptions`、`permissions` 的 zod schema。
  - 升级了 `mergeLayer` 支持多层配置深度合并。
- **`src/config/secrets.ts`**:
  - 实现了 `providerSource(provider)` 和 `writeSecret(provider, secret)`，安全读写 API Key 到 `~/.chovy/secrets/<provider>`。

## 3. 架构合规性与红线校验
- **秘密不入 Config**：所有 `apiKey` 通过 `writeSecret` 写入专用的 secrets 目录，Config 配置合并中包含 `stripSecretFields` 函数安全过滤，严格遵循红线 §5。
- **无新增 npm 依赖**：全部使用 ink 原生组件 (`useInput`, `Box`, `Text`) 实现，没有引入额外的包（如 ink-text-input），符合红线 §13。
- **类型安全**：当前修改的文件已完全通过 `bun run typecheck` 校验。

## 4. 下一步计划
完成 Settings 领域的基础通用面板后，后续继续进行配置向导（Wizard）的重构集成以及设置域的数据持久化打磨。
