# Step 52 (Wizard Refactor) 完成报告

## 1. 目标回顾
本步骤的目标是完成 ConfigWizard 到 SettingsField 的重构（Phase N，Step 52），要求：
- **外部行为完全不变**：保证配置写入文件时的字段、格式、去密处理和旧版逻辑严格一致。
- **配置入口三处合一**：命令行向导 `chovy config` 以及非交互式配置全部切换为调用 UI 的 `SettingsField.write` 接口，底层使用统一的 `runFieldOnce(fieldId, value)` 函数。
- **无破坏性更改**：保证 `smoke.ts` 和配置状态的不变性。

## 2. 变更详情
1. **统一的配置访问：**
   在 `src/screens/settings.tsx` 中新增导出 `runFieldOnce(fieldId, value)` 接口，它会遍历注册过的 `SettingsField`，触发验证逻辑 `validate()` 并调用 `write(value)` 实现持久化写入。

2. **重构向导逻辑 (`src/cli/configWizard.ts`)：**
   将向导中硬编码的 `config.json` 及 `secrets/<provider>` 文件修改和合并逻辑全部删除。采用顺序调用 `runFieldOnce` 的方式注入：
   - `provider.current`
   - `model.current`
   - `general.permissionMode`
   - `provider.apiKey`
   
   针对 `loadConfig().provider` 对 `SettingsField` 读取产生的非交互环境问题，我们包装了 `process.env['CHOVY_PROVIDER']`，让 API key 的写入能够正确捕捉向导中指定的目标 `provider` 而非由于全局环境变量（Mock 或父进程）产生的偏移。

3. **修复配置清理与字段删除：**
   - 修正了 `src/config/config.ts` 的 `mergeLayer` 函数，使其支持通过传入 `undefined` 删除对应的 JSON 键名，从而实现交互向导中选择无 Model 或重置 Model 时的清理行为。
   - 修复了 `src/screens/settingsTabs/model.tsx` 中的写入逻辑，若 Model 为空字符串会自动作为 `undefined` 传给合并层，从而触发删除。

4. **适配测试用例 (`secrets.ts` & `general.tsx`)：**
   - 将 `general.permissionMode` 的 `SettingsField` 重置为修改根节点的 `permissionMode`，以完美对齐旧版行为。
   - 去除了 `writeSecret` 中多余的换行符 `\n`，确保 `secrets/<provider>` 文件的内容字节级地与旧版和测试用例期望的值完全匹配。

## 3. 验收结果
- `bun run typecheck` 通过（移除了未使用的 `safeFs` 等遗留依赖模块引用）。
- `bun run smoke` **全部测试通过 (12 passed)**，其中 `config non-interactive` 能够正常测试读写和无密文泄露，满足了“外部行为完全不变”的红线要求。
