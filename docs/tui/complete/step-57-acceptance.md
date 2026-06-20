# Step 57: 全局焦点环 v2 (Focus Ring v2) 完成报告

## 1. 目标回顾
将原来分散于 `repl.tsx` 中通过 `useState` 控制的局部焦点，提升并重构为**支持全局统一调度**的全局焦点环。新架构增加了以下能力：
- 支持 6 个焦点目标 (`input`, `palette`, `settings`, `swarm`, `goal`, `companion`)。
- 能够基于组件可见性 (`visibility-aware`) 以及模态对话框互斥 (`modality` exclusive) 动态跳过不需要响应的目标。
- 提供了视觉一致的提示和统一的快捷键分发。

## 2. 交付产物

### 核心实现
- **`src/cli/state/focusStore.ts`**: 使用 `useSyncExternalStore` 实现了全局状态管理，存储当前的焦点 (`current`)、隐藏面板屏蔽列表 (`hidden`) 和模态激活状态 (`modality`)，并提供了 `cycleFocus` (Tab / Shift+Tab)、`setHidden` 等调度 API。
- **`src/cli/components/FocusHint.tsx`**: 独立渲染的提示信息行，悬浮在 InputBox 之上，指引用户如何通过 `Tab` 或 `Esc` 进行切换。
- **`src/cli/repl.tsx`**: 移除了旧有的局部 Focus 状态，挂载 `useFocusStore()` 并通过 `useKeybinding` 为 Tab 绑定全局调度。补全了基于设置和状态变更的可见性 (`showSwarmPanel`、`showGoalPanel`、`companionPrefs.visible` 等) 上报机制 (`setHidden`)。

### 组件焦点感知
- **`src/cli/components/SwarmPanel.tsx`**: 接收 `focused` prop，并在获得焦点时将边框颜色切换至 `theme.accent` 且使得面板标题反相。
- **`src/cli/components/GoalPanel.tsx`**: 同上，焦点状态激活时进行相应的视觉切换。
- **`src/companion/CompanionHost.tsx`**: 通过 `focused` 接收状态，高亮吉祥物的展示区；增加了 `useInput` 快捷键，在焦点落入吉祥物身上时，允许使用 `↑/↓` 来切换皮肤，按 `Enter` 等效执行触摸宠物效果。

### 模态窗口协调
- **`src/palette/state.ts`** & **`src/screens/state.ts`**:
  - 组件打开时 (`openPalette` / `openSettings`) 能够主动触发 `setModality` 告知焦点管理器。
  - 通过向 `focusStore` 挂载 `subscribe` 监听方法，保证当全局模态状态退出时，自身随之安全关闭，彻底去除了 `screens` 和 `palette` 之间相互引用的硬编码。

### 测试用例
- **`scripts/smoke-step57.ts`**: 新增了全方位的单元测试验证环路逻辑：输入到吉祥物间的穿梭验证、单向和反向切焦、根据可视状态跳过组件、互斥模态下的焦点收束锁定，均稳定且成功。

## 3. 验收标准达成情况
- [x] **类型安全**: `bun run typecheck` 通过，没有任何错误。
- [x] **可见焦点循环**: chovy 启动后，Tab 在 input ↔ companion 间切换正常。启动 Swarm / Goal 任务后会自动进入循环，关闭时自动移出循环。
- [x] **模态互斥锁**: `Ctrl+P` 打开 palette 后 modality 激活，Tab 仅在 input ↔ palette 之间切。`Ctrl+,` 调出 settings 后，palette 自动隐退关闭，实现相互排斥且独立。
- [x] **退路逻辑**: `Esc` 在任何激活状态下，均能够安全回到 input 并清理 modality。
- [x] **特殊环境响应**: 当设置 `CHOVY_NO_COMPANION=1` 或应用层面设置 `companion.visible = false` 时，焦点环会自动略过 companion 节点。
- [x] **单元测试验证**: `smoke-step57.ts` 内包含的所有单元用例均全线通过。

## 4. 结论
全局焦点环（SMOOTH-3.3 创新）顺利实施，无缝取代了旧有的焦点管理机制，整个交互反馈符合 TUI 第一梯队交互标准。已为下一步的验收预备妥当。
