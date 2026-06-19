# Step 39 完成报告：Companion 集成主屏

## 1. 目标与背景
本项目隶属 TUI 第二阶段路线图（Phase K - Mascot），目标是将 `CompanionHost` 挂载至主屏幕（`repl.tsx`）的 `InputBox` 旁边。集成过程需要满足界面宽度的自适应和避让处理，防止布局抖动；同时需根据状态机的切换弹出中英双语的提示气泡，并在无活动时自动淡出。

## 2. 核心工作内容
1. **字符串排版能力 (`wrapByDisplayWidth`)**：
   - 补充实现了带有全角/半角检测的 `wrapByDisplayWidth` 方法，确保在中英混合的长句下依然可以平滑截断，不超过气泡的最大宽度限制。
2. **气泡组件 (`SpeechBubble` / `quips.ts`)**：
   - 构建了纯 UI 的 `SpeechBubble` 气泡组件。
   - 使用主题色 (`theme.primary`, `theme.accent`, `theme.success`, `theme.error`) 动态对应 Companion 状态。
   - 引入气泡内的内置随机语言资源 `pickQuip()` 适配了 `done` 和 `error` 的弹出逻辑。
3. **伴侣宿主环境 (`CompanionHost`)**：
   - 负责监听全局状态单例 (`getCompanionStateMachine()`) 和响应 8 秒钟后清空气泡 (`reactionTimerRef`)。
   - 完成了根据终端列数 (`caps.cols`) 的条件渲染：当宽度 `< 60` 时直接渲染 `NarrowFace`（纯文本字符画），否则渲染 `CompanionPlayer` (GIF)。
4. **状态互操作接口 (`index.ts`)**：
   - 提供 `mountCompanion`，以闭包形式返回包含 `setState`, `dispose`, `skin`, `mute`, `pet` 动作的 `CompanionHandle` 实例（冻结的 B9 接口设计）。
   - 提供了简单的内存 Hook 封装 `useUserSkin`, `useCompanionMuted` 和变更接口，便于将状态控制下发到宿主内部而不再触发顶层重绘。
5. **主界面的注入 (`repl.tsx`)**：
   - 通过将 `InputBox` 与 `CompanionHost` 包裹在 Flex 行布局内，在不将 `InputBox` 和 `Companion` 内嵌的前提下达成等宽互斥。
   - 实现了 `companionReservedColumns()` helper 保证无论此时吉祥物是否说话，都给右侧留存定长的空间，解决了文本换行时的跳动（抖动）问题。

## 3. 测试验证 (验收标准)
- [x] **架构约束**：严格遵守无环依赖和 B9 冻结接口（没有增减 `CompanionHandle` 原定方法）。
- [x] **降级展示**：能够根据终端宽度自动切换 `NarrowFace`，或在使用 `CHOVY_NO_COMPANION=1` 环境变量时完全跳过渲染。
- [x] **内存与资源泄漏排查**：挂载 / 销毁能够完整清理 `reaction` 定时器和内部 `setTimeout` 渲染器。
- [x] **自动构建和类型检查**：运行 `bun run typecheck` 通过，没有 TypeScript 错误。
- [x] **冒烟测试**：新增并执行 `scripts/smoke-step39.ts` 通过，确保资源得到完整的生命周期管理。

## 4. 下一步建议
当前状态变更尚未在 `config.json` 进行物理持久化，可随进入 Phase N（Settings）进一步通过 `runFieldOnce` 统筹保存至全局配置表。在随后的 **Step 40** 中将为 `companion` 的皮肤更换功能集成至命令行与 UI 测试中。
