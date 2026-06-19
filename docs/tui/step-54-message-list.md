# Step 54 — MessageList 虚拟化 + 折叠 + 工具调用块

**Phase**: O | **依赖**: B8 (J 屏障) | **可并行**: 53, 55 | **估时**: 3h

## 目标

把既有 `src/cli/components/MessageList.tsx` 增强：

1. **虚拟化**：消息超过 N 条时只渲染 viewport 内的，避免 Ink 卡顿；
2. **工具调用折叠块**：tool message 默认折叠成单行 `▶ file_read(path) → 1.2KB`，点开看细节；
3. **reasoning / thinking 分段**：按 Settings 的 `general.showReasoningSummaries` 展示或折叠；
4. **assistant 消息分段**：长文本（> 3000 chars）默认折叠为 `[...展开 N 字符]`；
5. **主题色 + i18n** 接入。

## 产物

```
src/cli/components/
├── MessageList.tsx           # 重构主入口
├── MessageRow.tsx            # 单条消息
├── ToolCallBlock.tsx         # 折叠的工具调用块
├── CollapsibleText.tsx       # 长文本折叠展开
└── messageListState.ts       # 虚拟化滚动 state
```

## 实现要点

### 1. 虚拟化 + 滚动

```ts
// src/cli/components/messageListState.ts
export interface ViewportState {
  scrollTop: number;          // 顶部消息索引
  visible: number;            // 当前可见条数
}
```

简化策略：消息总数 ≤ 30 → 全渲染；> 30 → 取最后 30 条 + 顶部"[省略 N 条]"占位（可按 PgUp 滚回去）。
Ink 不真正支持 virtualization；这种"截断式"避免 Box children 过多导致 reconcile 慢。

```tsx
const VISIBLE_CAP = 30;
function selectVisible(messages: UIMessage[], scrollTop: number): UIMessage[] {
  if (messages.length <= VISIBLE_CAP) return messages;
  return messages.slice(scrollTop, scrollTop + VISIBLE_CAP);
}
```

PgUp/PgDn 调 scrollTop；用户开始打字 → scrollTop 跳回末尾。

### 2. ToolCallBlock — 默认折叠

```tsx
interface Props { name: string; argsBrief: string; resultMeta?: { ok: boolean; bytes?: number; durMs?: number; errorCode?: string } }
function ToolCallBlock({ name, argsBrief, resultMeta }: Props) {
  const defaultOpen = name === "shell" ? loadConfig().general?.shellToolPartsExpanded : loadConfig().general?.editToolPartsExpanded;
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const theme = useTheme();
  const dot = resultMeta?.ok === false ? <Text color={theme.error}>✗</Text> : <Text color={theme.success}>✓</Text>;
  const dur = resultMeta?.durMs ? `${resultMeta.durMs}ms` : "-";
  const sz  = resultMeta?.bytes !== undefined ? `${formatBytes(resultMeta.bytes)}` : "-";
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{open ? "▼ " : "▶ "}</Text>
        <Text bold color={theme.accent}>{name}</Text>
        <Text dimColor>{`(${argsBrief}) → `}</Text>
        {dot}
        <Text dimColor>{`  ${dur} · ${sz}`}</Text>
      </Box>
      {open ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>{t("msg.tool.errorCode", { code: resultMeta?.errorCode ?? "—" })}</Text>
          {/* 完整 args / 完整结果文本 */}
        </Box>
      ) : null}
    </Box>
  );
}
```

按 Tab 进入消息列表焦点 → ↑↓ 选行 → Enter 展开/折叠（与 step-57 焦点环对接）。

### 3. CollapsibleText（长 assistant 文本）

```tsx
const FOLD_THRESHOLD = 3000;
function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(text.length <= FOLD_THRESHOLD);
  if (open) return <Text>{text}</Text>;
  const head = text.slice(0, 800);
  return (
    <Box flexDirection="column">
      <Text>{head}</Text>
      <Text dimColor>{t("msg.fold.more", { n: text.length - 800 })}</Text>
    </Box>
  );
}
```

### 3.1 Reasoning / thinking block

```tsx
function ReasoningBlock({ text }: { text: string }) {
  const show = loadConfig().general?.showReasoningSummaries ?? true;
  const [open, setOpen] = useState(show);
  return (
    <Box flexDirection="column">
      <Text dimColor>{open ? "▼ " : "▶ "}{t("msg.reasoning.summary")}</Text>
      {open ? <Text dimColor>{text}</Text> : null}
    </Box>
  );
}
```

`/thinking` 和 Ctrl+P `message.toggleThinking` 修改同一 config 字段；Settings、slash、palette 三入口行为一致。

### 4. MessageRow

```tsx
function MessageRow({ msg }: { msg: UIMessage }) {
  const theme = useTheme();
  const prefix = msg.role === "user"      ? <Text color={theme.accent} bold>›</Text>
              : msg.role === "assistant" ? <Text color={theme.primary} bold>chovy</Text>
              : msg.role === "tool"      ? null
              : <Text dimColor>·</Text>;
  if (msg.role === "tool") {
    return <ToolCallBlock {...parseToolMeta(msg)} />;
  }
  return (
    <Box flexDirection="row">
      <Box marginRight={1}>{prefix}</Box>
      <Box flexGrow={1}>
        {msg.role === "assistant" && msg.content.length > 0
          ? <CollapsibleText text={msg.content} />
          : <Text dimColor={msg.role === "system"}>{msg.content || (msg.pending ? "…" : "")}</Text>}
      </Box>
    </Box>
  );
}
```

### 5. 性能 — 减少 React reconcile

- MessageRow 用 React.memo + 自定义 isEqual（仅 msg.id + msg.content + msg.pending 变化触发）；
- 流式 onToken 频繁更新最后一条 → 虚拟化已经把它放在底部，只 reconcile 一行；
- ToolCallBlock 的 open state 内部维护，不污染父；
- 整个 MessageList 100 条消息 + 流式更新最后条 → 单帧 < 50ms。

## 接口冻结 / 不变量

- `UIMessage` 既有字段不动（id/role/content/pending/interrupted）；
- 折叠阈值常量写死（FOLD_THRESHOLD=3000、VISIBLE_CAP=30），不进 config；
- reasoning/tool 默认展开状态来自 SettingsField 写入的 config，运行时切换立即影响新消息，旧消息保留用户手动展开状态；
- 工具调用 meta 来自既有 `ToolResult.meta`（AGENTS.md §16 单源）；本步只解析展示，不重算；
- 消息排序仍按到达顺序（不重排）。

## 验收标准

- `bun run typecheck` 通过；
- 跑 chovy 让 agent 调 5 个工具 → MessageList 显示 5 条折叠块，每块单行；
- Tab 进焦点 + Enter 展开任意一块 → 展示完整 args / errorCode；
- `/thinking` 或 Settings 关闭 reasoning summaries → 新 reasoning block 默认折叠；
- 让 assistant 输出 > 3000 字符 → 自动折叠 + 展开提示；
- 100 条消息 + 第 100 条流式 token → 不卡顿（视觉 60fps 接近）；
- `scripts/smoke-step54.ts`：mock messages.length=100 → 渲染只 mount 30 个 MessageRow（spy）。

## 风险

- **流式更新触发 reconcile**：onToken 200 次 → 100 个 React render；用 throttle setMessages 16ms；
- **CollapsibleText 展开后 vt sequence 错位**：长文本含 \r 等字符；先 sanitize 再渲染；
- **滚动 state 与 stream 冲突**：用户 PgUp 后又来流式 → 自动跳回底部 vs 保持当前位置 → 默认保持，加 hint「按 End 跳到末尾」。
