# Step 46 验收报告：HeaderBar v2 chip 系统 + 主题接入

## 1. 目标
对现有的 `HeaderBar.tsx` 组件进行重构，将其拆解为多个子组件（Chips），并无缝接入主题与动态终端宽度下的智能折叠策略。

## 2. 交付清单
- [x] **基础设施搭建**: 创建了通用的 `<Chip />` 组件（`src/cli/components/chips/Chip.tsx`）。
- [x] **专用 Chip 组件拆分**:
  - `ModeChip.tsx`：模式标签与颜色展示。
  - `ProviderModelChip.tsx`：提供商和模型名称展示。
  - `CtxChip.tsx`：通过读取上下文预算快照的 `pressureLevel` 实现智能告警变色（Fresh/Soft/Hard）。
  - `CostChip.tsx`：花费总额格式化显示。
  - `SwarmChip.tsx`：协调模式（Coordinator）子智能体进度展示。
  - `GoalChip.tsx`：目标循环中的轮数和金额花费记录展示（带有暂停和播放状态）。
- [x] **响应式折叠（chooseChips）**: 在 `HeaderBar.tsx` 引入了根据终端宽度自动选择隐藏次要信息的策略。依次丢弃：`Swarm` -> `Goal` -> `Cost` -> `Ctx`，以保障主逻辑信息能够始终完整可见。
- [x] **多语言（i18n）支持**: 在 `en.ts` 和 `zh.ts` 配置中添加了 `header.goal` 的模板定义。
- [x] **REPL 状态注入**: 更新了 `repl.tsx`，在非空状态下将 `goalSummary` 安全向下传递，不破环之前的 `Props` 接口类型。
- [x] **验收测试**: 添加并执行了 `scripts/smoke-step46.tsx`，通过 Mock 不同宽度的终端能力并检查渲染流中的节点，验证了以上逻辑均表现正常。

## 3. 非破坏性兼容
- 组件接口兼容：完全保留了现有调用方的 Props，所有新增参数（例如 `goal`）皆为可选属性。
- TypeScript 类型安全：经过 `bun run typecheck` 验证，没有产生类型回归错误。
