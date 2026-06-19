# Step 47 (Tips & Onboarding) 完成报告

## 1. 产物达成情况
- **`src/screens/onboarding.ts`**: 实现了 `OnboardingState` 的持久化管理（存入 `~/.chovy/cache/onboarding.json`），使用 atomic rename 保证并发写入安全。对外暴露 `loadOnboarding`、`saveOnboarding` 及核心业务方法 `recordEvent`。
- **`src/screens/tips.ts`**: 实现了 `useDynamicTips` Hook，能够基于用户的历史操作记录（例如是否用过命令面板、是否切过语言、是否互动过吉祥物等）动态生成欢迎屏的 tips 列表，最多展示 5 条。
- **UI 界面更新**:
  - `src/screens/welcome.tsx` 成功接入 `useDynamicTips`，正式替换掉了原先的静态占位 tips。
  - `src/cli/repl.tsx` 已接入 `<OnboardingHint />`。当用户初次启动（`firstActionAt` 为空）时，会在 HeaderBar 下方显示一条引导横幅；在用户首次发送指令或消息并触发 `send` 时，自动调用 `recordEvent("firstAction", version)` 并让该横幅永久消失，全程使用纯条件渲染。

## 2. 行为埋点接入
除了预留给 step-48 的 Settings 埋点外，所有跨模块事件挂载已全部完成：
- **命令面板**: `src/palette/index.tsx` 内的 `execAt` 中成功注入了 `recordEvent("palette", version)`。
- **多语言切换**: `src/i18n/index.ts` 内的 `setLocale` 成功时注入了 `recordEvent("lang", version)`。
- **虚拟伙伴交互**: `src/companion/index.ts` 内 `mountCompanion` 暴露的 `pet()` 回调中注入了 `recordEvent("buddy", version)`。

## 3. 测试与验证
- **功能自动化测试**: 独立编写并执行了 `scripts/smoke-step47.ts`，验证了 onboarding 文件创建、默认值读取以及 `recordEvent` 对磁盘属性状态的改变，成功通过测试（`smoke-step47 passed ✅`）。
- **类型安全**: 运行 `bun run typecheck` 通过 0 错误（顺便修复了之前其他遗留组件的未引用类型报错）。
- **版本升级体验**: 在 `useDynamicTips` 内，妥善利用 React 的 Hook 特性，确保当 `lastSeenVersion` 与当前版本不一致时，能准确渲染带有 `✨` 前缀的版本更新 tip，并在渲染后立即通过副作用持久化覆盖新版本，保证该体验有且仅出现一次，不会陷入刷新死循环。

## 4. 结论
Step 47 所涉及的新手状态机、全局体验 Tips 分发与多模块关联探针均已稳健实现并验证完毕。符合 `docs/tui/step-47-tips-and-onboarding.md` 中的各项指引要求，可以向下一步（Settings 界面架构）平滑推进。
