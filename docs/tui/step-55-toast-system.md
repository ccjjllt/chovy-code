# Step 55 — Notification / Toast 系统

**Phase**: O | **依赖**: B8 (J 屏障) | **可并行**: 53, 54 | **估时**: 2h

## 目标

为 chovy-code TUI 引入轻量 toast 通知（不打断输入、不挡 InputBox），用于：

- 主题切换成功 / 失败提示；
- 命令面板执行结果（如 `/clear` "已清屏"）；
- 后台事件（如 SwarmR 完成、checkpoint 写入）；
- 错误兜底（如 配置写盘失败）。

替换部分现有 `appendSystem(...)` 调用的"系统消息打扰"——分级走 toast 而非污染消息列表。

## 产物

```
src/cli/components/
├── ToastHost.tsx          # 全局挂载点（一个，repl.tsx 顶层）
├── Toast.tsx              # 单条 toast 渲染
└── toastBus.ts            # 进程内 pub/sub（与 swarmBus 同模式）

src/cli/repl.tsx           # mount <ToastHost /> 在 InputBox 上方
```

## 实现要点

### 1. ToastBus

```ts
// src/cli/components/toastBus.ts
export type ToastVariant = "info" | "success" | "warning" | "error";
export interface ToastInput {
  id?: string;                  // 用户提供则去重
  variant: ToastVariant;
  text: string;                 // 已经过 t() 的字符串
  durationMs?: number;          // 默认 4000；error 默认 8000
}
export interface ToastEvent extends ToastInput { id: string; createdAt: number; }

const _store: ToastEvent[] = [];
const _listeners = new Set<(items: ToastEvent[]) => void>();

export function showToast(input: ToastInput): string {
  const id = input.id ?? `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
  const ev: ToastEvent = { ...input, id, createdAt: Date.now() };
  // 去重
  const idx = _store.findIndex(t => t.id === id);
  if (idx >= 0) _store[idx] = ev; else _store.push(ev);
  emit();
  return id;
}
export function dismissToast(id: string): void { /* ... */ }
export function useToasts(): ToastEvent[] { /* useSyncExternalStore */ }
```

### 2. ToastHost

```tsx
const MAX_VISIBLE = 3;       // 同时最多 3 条；多余排队
export function ToastHost(): React.ReactElement | null {
  const items = useToasts();
  const visible = items.slice(-MAX_VISIBLE);
  // 自动消失：每条到期 setTimeout dismissToast
  useEffect(() => {
    const timers = visible.map(it => {
      const dur = it.durationMs ?? (it.variant === "error" ? 8000 : 4000);
      return setTimeout(() => dismissToast(it.id), Math.max(0, dur - (Date.now() - it.createdAt)));
    });
    return () => timers.forEach(clearTimeout);
  }, [visible]);
  if (visible.length === 0) return null;
  return (
    <Box flexDirection="column">
      {visible.map(t => <Toast key={t.id} item={t} />)}
    </Box>
  );
}
```

### 3. Toast

```tsx
function Toast({ item }: { item: ToastEvent }) {
  const theme = useTheme();
  const colors: Record<ToastVariant, string> = {
    info: theme.accent, success: theme.success, warning: theme.warning, error: theme.error,
  };
  const icons: Record<ToastVariant, string> = {
    info: "ℹ", success: "✓", warning: "⚠", error: "✗",
  };
  return (
    <Box borderStyle="round" borderColor={colors[item.variant]} paddingX={1}>
      <Text color={colors[item.variant]}>{icons[item.variant]}</Text>
      <Text> {item.text}</Text>
    </Box>
  );
}
```

### 4. 替换部分 appendSystem 调用

| 原 | 改 |
|---|---|
| `ctx.appendSystem("已清屏")` | `showToast({ variant: "success", text: t("toast.cleared") })` |
| `ctx.appendSystem("/${name} 执行失败：${msg}")` | `showToast({ variant: "error", text: t("toast.cmdFailed", { name, msg }) })` |
| 其它信息性提示 | toast |
| 用户消息回显 / agent 输出 | 仍走 messages |

> **不**全部替换：与对话相关的（agent 输出、用户输入、tool 调用结果）继续走 messages；
> 仅"事件性提示"（保存成功 / 命令失败 / 后台完成）走 toast。

### 5. 集成 step-22 swarmBus / step-21 judge / step-26 checkpoint

```ts
// repl.tsx 或 cli/state/swarmStore：
swarmBus.on("lifecycle", (ev) => {
  if (ev.event === "completed" && ev.role === "main_dispatch_done") {
    showToast({ variant: "success", text: t("toast.swarm.done", { ok: ev.okCount, total: ev.total }) });
  }
});
checkpointEvents.on("written", (path) => {
  showToast({ variant: "info", text: t("toast.checkpoint.written", { path: shortCwd(path, 30) }) });
});
```

后台事件触发 toast 而不污染 messages（之前 appendSystem 显得太吵）。

### 6. 视觉位置

ToastHost 挂在 **InputBox 上方**（紧贴 InputBox），不挂顶部——避免 HeaderBar 被遮挡。
SwarmPanel / GoalPanel 在 InputBox 上方的更上方；toast 在它们下方。最终顺序：

```
HeaderBar → MessageList → SwarmPanel → GoalPanel → ToastHost → InputBox
```

## 接口冻结 / 不变量

- `showToast` / `dismissToast` 是 mutation 单源；其它模块**不**直接 push 到 _store；
- toast 不持久化；进程退出即丢；
- toast 不进 telemetry（事件性提示无需远程汇总）；
- error toast 不会 cascade（一条错误不会自动转 messages 系统消息）。

## 验收标准

- `bun run typecheck` 通过；
- chovy 启动后跑 `/theme set X` → 弹一条 success toast 4s 后消失；
- 故意触发 / 命令失败 → 弹 error toast 8s；
- 同一 id 连续 showToast → 只刷新一次（不堆叠）；
- 终端 resize → toast 自适应宽度不溢出；
- `scripts/smoke-step55.ts`：showToast → useToasts 立即返回新条；setTimeout 后自动 dismiss。

## 风险

- **toast 堆积**：长任务后台事件密集 → 限制 MAX_VISIBLE=3 + 排队（FIFO）；
- **InputBox 抖动**：toast 出现 / 消失会顶升 InputBox 一行 → 已在 step-53 v2 内 useMemo 稳定；视觉可接受；
- **i18n 缺 key**：toast 显示 `[missing: ...]` → 是 step-32 missing 路径，不抛错。
