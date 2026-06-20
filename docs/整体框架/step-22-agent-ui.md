# Step 22 — Agent UI（Ink 子 agent 进度面板 + 取消）

**Phase**: E | **依赖**: 18 | **可并行**: ✅ | **估时**: 4h

## 目标

让用户在 Ink 终端 UI 中实时看到所有运行中子 agent 的状态，并能取消选中的 agent。

## 产物

```
src/cli/components/
├── SwarmPanel.tsx        # 主面板
├── AgentRow.tsx          # 单条
├── AgentDetail.tsx       # 详情浮层
└── HotkeyBar.tsx
src/cli/state/
└── swarmStore.ts         # 订阅 swarmBus 的 React 适配
```

## UI 布局

```
┌─ Swarm (3 running, 5 done) ─────────────────────── budget $0.18/$0.50 ┐
│ ▶ sa_a1b2 explore   ⏳ reading file foo.ts          12s  $0.02         │
│ ▶ sa_c3d4 plan      ⏳ drafting steps               09s  $0.05         │
│ ▶ sa_e5f6 critic    ⏳ scanning risks               14s  $0.04         │
│   sa_g7h8 verify    ✅ PASS                         07s  $0.01         │
│   sa_i9j0 explore   ❌ failed: budget exceeded      11s  $0.03         │
│   ...                                                                  │
│ [↑/↓] select  [x] cancel  [Enter] details  [Esc] close                 │
└────────────────────────────────────────────────────────────────────────┘
```

只渲染 top N（默认 8），其余折叠为 "+ N more"。

## 状态订阅

```ts
// state/swarmStore.ts
export function useSwarmState(): { agents: SubAgentHandle[]; budget: BudgetSnapshot } {
  // 内部 useEffect: swarmBus.on('lifecycle' | 'progress' | 'cost' ...) → setState
  // 16ms 节流（再快 Ink 也跟不上）
}
```

## 快捷键

- `↑/↓`：选择；
- `x`：cancel(selected)；
- `Enter`：打开 AgentDetail（显示完整 prompt、最近 phase、part of content）；
- `g`：切换到 GoalPanel；
- `Esc`：折叠面板。

## 详情浮层

```
┌─ sa_c3d4 / plan agent ──────────────────────────────────────┐
│ provider: kimi      model: kimi-k2     mode: default        │
│ status: running     phase: drafting steps                   │
│ tokens: in 4,123 / out 821       cost: $0.05                │
│                                                             │
│ Last output (preview):                                      │
│   1. Audit current build pipeline ...                       │
│   2. Replace ts-node with bun ...                           │
│                                                             │
│ [c] cancel  [s] save snapshot  [Esc] back                   │
└─────────────────────────────────────────────────────────────┘
```

## REPL 主屏集成

REPL（步骤 05）的右侧或下半区显示 SwarmPanel。无运行中子 agent 时面板自动收起，节省高度。
顶部 HeaderBar 显示 `swarm: 3R/2D  budget: $0.18`。

## 性能

- 仅渲染 visible rows（virtualization 简化版）；
- progress 事件经 16ms 节流；
- detail 面板主动 pull (每 200ms)；
- 100 个 agent 同时 running 时仍流畅。

## 验收标准

- dispatch 5 子 agent，UI 动态更新各自 phase；
- `x` 取消 → 0.5s 内 UI 标记 cancelling；
- 终止时无内存泄漏（subscribe/unsubscribe 配对）；
- 100 子 agent 压测时 UI 延迟 < 50ms。

## 参考源

- `cc-haha/src/components/`（panel 设计、HeaderBar）

## 风险

- Ink 5 在 Windows ConHost 闪烁 → 与步骤 05 同样推荐 Windows Terminal；提供禁用面板开关 `CHOVY_NO_SWARM_PANEL=1`。
