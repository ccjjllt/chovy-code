# Phase M 验收报告：Welcome & Header v2

## 验收步骤范围
本阶段涵盖了以下三个核心步骤（step-45..47）的完整落地与验证：
- **step-45**: WelcomeScreen 二栏布局（含吉祥物渲染复用与静态 Tips）
- **step-46**: HeaderBar v2 chip 系统 + 主题变色能力（含响应式终端宽度折叠逻辑）
- **step-47**: 基于持久化机制的新手引导 Tips + 隐式埋点收集 + 动态版本升级提示

## 验收检查结果

### 1. WelcomeScreen 首屏体验 (step-45)
- [x] 正确使用了 `<SplitPane />` 实现左侧吉祥物、右侧 Tips 的等比例或指定比例展示布局。
- [x] 组件能够判断 `CHOVY_NO_COMPANION=1` 并实现降级，且在宽度 < 80 字符的终端内正确回落到单栏结构。
- [x] 首次启动后，用户一经发送消息交互，系统便通过 `repl.tsx` 内的状态管理予以隐藏，并在后续 `/clear` 操作后**保持不再显示**的稳定行为。

### 2. HeaderBar 升级与动态折叠 (step-46)
- [x] 原有的大块文本已拆分成 `ModeChip`、`ProviderModelChip`、`CtxChip`、`CostChip` 等独立微组件，并成功保留 `props` 的向下兼容性。
- [x] 各 Chip 完美承接主题上下文系统（Theme Context），能依据不同行为状态呈现对应配色（如警告、常规、强调色）。
- [x] 实现并验证了严格的 `chooseChips` 降级策略，能在终端宽度不足时，根据预设优先级自右向左丢弃非核心属性标签。

### 3. Onboarding 状态机与智能 Tips (step-47)
- [x] 成功运用了基于文件系统的原子写入重命名设计，维护 `~/.chovy/cache/onboarding.json` 里的操作数据（如是否打开调色板、切换语言、触碰吉祥物等）。
- [x] 新手提示与使用习惯高度关联，已取代了原来硬编码在 UI 内的占位符。在测试中确认修正了 `zh.ts` 与 `en.ts` 的重复子弹符号渲染，实现整洁排版。
- [x] 对于底层版本发生跨越时，UI 层能精确抓取变动并在 Tips 中优先输出版本迭代提示，并完成自身标记更新。

## 综合结论
- **代码结构安全性**：所有 TUI 变更遵守叶子层不侵入引擎内环规则，保持单向依赖隔离。
- **类型安全性**: 运行 `bun run typecheck` 实现零错误报错。
- **运行时功能**: 运行了 `scripts/smoke-step45.tsx`、`scripts/smoke-step46.tsx`、`scripts/smoke-step47.ts` 均成功退出。

**验收结论**：**Phase M (Welcome & Header v2) 通过验收**。已准备好向 Settings (Phase N) 与 Polish 阶段挺进。
