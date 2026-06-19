# Step 57 — 全局焦点环 v2（input ↔ palette ↔ settings ↔ swarm ↔ goal ↔ companion）

**Phase**: O | **依赖**: 39, 44, 48 | **估时**: 3h | **创新**: SMOOTH-3.3

## 目标

把当前 REPL 内分散的 useState 焦点（`focus: "input"|"swarm"|"goal"`）扩展为**全局焦点管理**：

- 6 个焦点目标：`input / palette / settings / swarm / goal / companion`；
- Tab / Shift+Tab 在**可见**焦点间循环（visibility-aware ring）；
- **modality 互斥**：palette / settings 是模态——打开期间禁用其它焦点；
- 视觉一致：焦点元素边框变 `theme.accent` + 文本反相；
- "焦点提示行" 常驻 InputBox 上方（"Tab 切换 / Esc 退出"）。

## 产物

```
src/cli/state/
└── focusStore.ts            # FocusTarget union + ring + cycle 函数

src/cli/components/
└── FocusHint.tsx            # 焦点提示行

src/cli/repl.tsx             # 重构 focus 实现：useFocusStore() + cycle
```

## 实现要点

### 1. FocusTarget 联合

```ts
// src/cli/state/focusStore.ts
export type FocusTarget = "input" | "palette" | "settings" | "swarm" | "goal" | "companion";

export interface FocusState {
  current: FocusTarget;
  // 屏蔽列表：当前不可见 / 不可达的目标
  hidden: Set<FocusTarget>;
  modality?: "palette" | "settings";   // 模态打开期间，ring 收缩
}
```

### 2. ring 计算（visibility-aware）

```ts
const RING_ORDER: FocusTarget[] = ["input", "swarm", "goal", "companion", "palette", "settings"];

export function nextFocus(state: FocusState, dir: 1 | -1): FocusTarget {
  // 模态打开期间，ring 仅含 modality 自身 + input
  let candidates: FocusTarget[];
  if (state.modality) {
    candidates = ["input", state.modality];
  } else {
    candidates = RING_ORDER.filter(t => !state.hidden.has(t) && t !== "palette" && t !== "settings");
    //       palette / settings 不进入默认 ring（仅靠 Ctrl+P / Ctrl+, 入口）
  }
  if (candidates.length === 0) return "input";
  const idx = candidates.indexOf(state.current);
  if (idx < 0) return candidates[0]!;
  const n = candidates.length;
  return candidates[(idx + dir + n) % n]!;
}
```

### 3. modality 自动管理

```ts
// 打开 palette → setModality("palette")，focus = palette
export function openPalette(): void {
  _setFocus({ current: "palette", modality: "palette", hidden: _state.hidden });
}
export function closePalette(): void {
  _setFocus({ current: "input", modality: undefined, hidden: _state.hidden });
}
// settings 同理
```

互斥：openSettings 时若 modality=palette → 自动关 palette + 切 settings。

### 4. 可见性同步

repl.tsx 内挂监听：

```tsx
useEffect(() => {
  setHidden({
    swarm: !showSwarmPanel,
    goal: !showGoalPanel,
    companion: process.env["CHOVY_NO_COMPANION"] === "1" || muted,
  });
}, [showSwarmPanel, showGoalPanel, muted]);
```

`hidden=true` 的目标自动从 ring 跳过；当前 focus 落到隐藏目标时自动回 input。

### 5. 视觉反馈

各 panel 接 `focused: boolean` prop：

```tsx
<SwarmPanel focused={focus === "swarm"} ... />
<GoalPanel  focused={focus === "goal"}  ... />
<CompanionHost focused={focus === "companion"} ... />
```

各组件用 `theme.accent` 边框 + 标题反相（与 step-35 Panel 既有）。

### 6. FocusHint 提示行

```tsx
function FocusHint() {
  const focus = useFocus();
  if (focus === "input") return null;
  const theme = useTheme();
  return (
    <Box paddingX={1}>
      <Text dimColor>{t("focus.hint", { target: t(`focus.target.${focus}`) })}</Text>
    </Box>
  );
}
```

i18n keys：

- `focus.hint`: "当前焦点：{target} · Tab 切换 · Esc 回到输入"
- `focus.target.swarm`: "Swarm 面板"
- `focus.target.goal`: "Goal 面板"
- `focus.target.companion`: "吉祥物"

挂在 InputBox 正上方 1 行（focus=input 时不渲染）。

### 7. companion 焦点交互

聚焦 companion 时：
- ↑↓ 切换 skin（与 /buddy skin 等价）；
- Enter 摸吉祥物（等价 Ctrl+B）；
- Esc 回 input。

不影响 GIF 播放，只是高亮吉祥物边框。

### 8. 既有 ChovyRepl 重构

```tsx
// 旧：const [focus, setFocus] = useState<Focus>("input");
// 新：const focus = useFocus();
useKeybinding("focus.next", () => cycleFocus(1),  { isActive: !busy });
useKeybinding("focus.prev", () => cycleFocus(-1), { isActive: !busy });
```

## 接口冻结 / 不变量

- `FocusTarget` 联合扩展只追加（B10 兼容）；
- modality 与 focus.current 不允许"unconsistent"状态（modality=palette 但 focus=swarm 是 illegal）—— store 内强制；
- ring 顺序写常量数组，不进 config；
- focus 切换**不**通知 telemetry（高频 UI 行为）；
- busy=true 时禁用 cycle（用户运行期间不应改焦点）—— 既有不变量沿用。

## 验收标准

- `bun run typecheck` 通过；
- chovy 启动 → Tab 在 input → companion 间切换；
- 启动 SwarmR → 多一个 swarm 焦点；done 后自动移出 ring；
- Ctrl+P 打开 palette → modality 激活 → Tab 仅在 input ↔ palette 间切；
- Ctrl+, 打开 settings → palette 自动关；Tab 仅 input ↔ settings；
- Esc 在任一焦点 → 回 input + 关 modality；
- `CHOVY_NO_COMPANION=1` → ring 不含 companion；
- `scripts/smoke-step57.ts`：cycleFocus 单元 + modality 互斥单元全过。

## 风险

- **既有 setFocus 调用被遗漏**：审计 repl.tsx 全部 setFocus → 替换为 cycleFocus / setFocus（store API）；
- **CHOVY_NO_SWARM_PANEL 仍生效**：env 关 swarm panel → hidden swarm 自动；既有 §22 不变量沿用；
- **modality 死锁**：极端场景下 palette 和 settings 同时打开（不应该发生）→ store mutator 强制互斥，违反则 warn + 回滚。
