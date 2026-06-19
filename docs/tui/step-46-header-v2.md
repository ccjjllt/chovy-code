# Step 46 — HeaderBar v2 chip 系统 + 主题接入

**Phase**: M | **依赖**: B8 (J 屏障) | **可并行**: 45 | **估时**: 3h

## 目标

把既有 `src/cli/components/HeaderBar.tsx` 升级到 v2：

1. 主题色接入（不再硬编码 `cyan/yellow/green`）；
2. **chip 系统**：每个状态字段（mode / provider / model / ctx / cost / swarm / goal）独立 chip；
3. 支持 chip 隐藏 / 折叠（窄终端动态裁剪）；
4. i18n 化所有标签；
5. **保持 BudgetSnapshot / SwarmSummary props 签名向后兼容**（AGENTS.md §22/§23 frozen-extension）。

## 产物

```
src/cli/components/
├── HeaderBar.tsx           # v2 改造（保留既有 props 接口）
├── chips/
│   ├── ModeChip.tsx
│   ├── ProviderModelChip.tsx
│   ├── CtxChip.tsx         # 含 SCW pressureLevel 着色
│   ├── CostChip.tsx        # 接 i18n/format.formatCost
│   ├── SwarmChip.tsx
│   └── GoalChip.tsx        # 新增（goalState 在跑时显示 round/budget）
└── chips/index.ts
```

## 实现要点

### 1. 既有 props 不动

```ts
// 仍然是：
interface Props {
  mode: PermissionMode;
  provider: string;
  model: string;
  budget: BudgetSnapshot;            // §22 既有
  swarm?: SwarmSummary;              // §22 既有
  goal?: GoalChipSnapshot;           // 新增可选（frozen-extension）
}
export interface GoalChipSnapshot {
  rounds: number;
  status: "active" | "paused";
  budgetUsed: number;
  budgetCap?: number;
}
```

### 2. Chip 通用结构

```tsx
// chips/Chip.tsx（共用，不单独导出）
function Chip({ icon, label, color, dim, bold, hint }: ChipProps) {
  return (
    <Box marginRight={1}>
      {icon ? <Text color={color}>{icon} </Text> : null}
      <Text color={dim ? undefined : color} dimColor={dim} bold={bold}>{label}</Text>
      {hint ? <Text dimColor>{` ${hint}`}</Text> : null}
    </Box>
  );
}
```

### 3. ModeChip — 主题接入

```tsx
const MODE_KEY: Record<PermissionMode, string> = {
  default: "header.mode.default",
  plan: "header.mode.plan",
  acceptEdits: "header.mode.acceptEdits",
  auto: "header.mode.auto",
  bypassPermissions: "header.mode.bypass",
};
export function ModeChip({ mode }: { mode: PermissionMode }) {
  const theme = useTheme();
  const colors: Record<PermissionMode, string> = {
    default: theme.accent,
    plan: theme.warning,
    acceptEdits: theme.success,
    auto: theme.primary,
    bypassPermissions: theme.error,
  };
  return <Chip icon="▎" label={t(MODE_KEY[mode])} color={colors[mode]} bold />;
}
```

### 4. CtxChip — SCW pressureLevel 着色（接 step-27/§22 不变量）

```tsx
export function CtxChip({ used, total, level }: { used: number; total: number; level?: "fresh"|"soft"|"hard" }) {
  const theme = useTheme();
  const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
  const color = level === "hard" ? theme.error : level === "soft" ? theme.warning : undefined;
  return <Chip label={t("header.ctx", { pct })} color={color ?? theme.muted} dim={!color} bold={level === "hard"} />;
}
```

`pressureLevel` 单源仍是 step-27 ContextMonitor，不在本步重新派生。

### 5. GoalChip（新增）

```tsx
export function GoalChip({ snap }: { snap: GoalChipSnapshot }) {
  const theme = useTheme();
  const used = snap.budgetUsed.toFixed(2);
  const cap = snap.budgetCap !== undefined ? `/$${snap.budgetCap.toFixed(2)}` : "";
  const dot = snap.status === "paused" ? "⏸" : "▶";
  return <Chip icon={dot} label={t("header.goal", { rounds: snap.rounds, used, cap })}
               color={snap.status === "paused" ? theme.warning : theme.accent} bold />;
}
```

repl.tsx 在 goalState 非空时计算 `goal: { rounds, status, budgetUsed: goal.totalCostUSD, budgetCap: goal.budgetUSD }`
传给 HeaderBar；既有调用方不传也兼容。

### 6. 折叠策略（窄终端）

```ts
// 优先级（从左往右、保留高优先到 chop 低优先）：
// mode > model > ctx > cost > goal > swarm
function chooseChips(caps: TerminalCaps, snapshot: ChipDataset): Chip[] {
  const all = ["mode","model","ctx","cost","goal","swarm"];
  const widths = all.map(estimateChipWidth);
  let total = sum(widths) + (all.length - 1);
  if (total <= caps.cols - 4) return all;
  // 从右往左 drop 直到 fit
  const result = [...all];
  while (result.length > 1 && total > caps.cols - 4) {
    const dropped = result.pop()!;
    total -= estimateChipWidth(dropped) + 1;
  }
  return result;
}
```

`estimateChipWidth` 用 step-33 stringWidth（CJK aware）。

### 7. 边框色

```tsx
export function HeaderBar({ mode, ... }: Props) {
  const theme = useTheme();
  const borderColor = MODE_BORDER_COLOR[mode] ?? theme.primary;
  return (
    <Box justifyContent="space-between" borderStyle={theme.borderStyle} borderColor={borderColor} paddingX={1}>
      <Box>{leftChips.map(c => renderChip(c))}</Box>
      <Box>{rightChips.map(c => renderChip(c))}</Box>
    </Box>
  );
}
```

## 接口冻结 / 不变量

- `Props` 既有字段（mode/provider/model/budget/swarm）**字段名不动**；新增 `goal` 是可选；
- `BudgetSnapshot.pressureLevel` 联合不动（§22）；
- chip 拆分是**纯渲染重构**，不改 HeaderBar 调用方；
- 折叠策略写常量数组，不进 config（避免用户调成 mode 也不显示导致诊断困难）；
- 不增加 telemetry 事件（HeaderBar 是消费方）。

## 验收标准

- `bun run typecheck` 通过；
- 既有 repl.tsx 不改 HeaderBar 调用 → 仍正常渲染（向后兼容）；
- `/theme set ChovyHighContrast` → ModeChip 颜色立即变化；
- resize 到 60 cols → swarm/goal chip 自动隐藏，mode 与 model 仍在；
- goalState 非 null 时 GoalChip 显示 rounds 与 cost，paused 时 ⏸ 黄色；
- `scripts/smoke-step46.ts`：mock props → 渲染 snapshot 含全部 chips；resize 到 50 → 仅含 mode chip。

## 风险

- **chip 估算误差**：CJK 字符宽度估算偏差导致折叠不准；用 step-33 stringWidth 精确算。
- **goal chip 与 GoalPanel 冲突**：HeaderBar 显示 round/budget，GoalPanel 显示更多——chip 是 summary，不重复 panel 详情。
- **HeaderBar 行高**：chip 化后单行可能过长 → 折叠优先；不允许换行成 2 行（视觉规约）。
