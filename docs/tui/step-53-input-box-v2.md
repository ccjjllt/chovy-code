# Step 53 — InputBox v2（多行 / 历史 / 补全 hint / paste 检测）

**Phase**: O | **依赖**: B8 (J 屏障) | **可并行**: 54, 55 | **估时**: 3h | **创新**: SMOOTH-3.1

## 目标

把既有 `src/cli/inputBox.tsx` 升级到 v2：

1. **零延迟**：所有按键反馈 ≤ 16ms（不在 keypress 内做 fs / i18n lookup）；
2. **多行**：Shift+Enter 换行 / 输入超过一行自动 wrap；
3. **历史**：↑↓ 浏览（既有），新增 `Ctrl+R` 反向搜索；
4. **斜杠补全 hint**：输入 `/` 后右侧弹出最匹配命令名（按 Tab 补全），候选来自 step-44 的 command store 单源，包含内置 slash、skills、plugins、workflows、MCP；
5. **paste 检测**：粘贴大于 N 字符时识别为粘贴 → 折叠显示 `[粘贴 N 字符]` 占位。

> ⚠ **评审注记（对标 claude-code · 详见 `review-claude-code-alignment.md §2.3`）**：
> 现有 step-53 只覆盖 `/` slash + paste，缺 claude-code 输入区的几个核心模式。建议把以下追加进本步产物/验收：
> - **`@` 文件引用 + 模糊文件选择器**（claude-code 最核心的上下文附加方式）：行内 `@path` 触发 fs fuzzy picker
>   （复用 step-42 模糊搜索 + fs 列举），选中后作为上下文引用插入。**这是当前计划最明显的输入缺口，优先补。**
> - **`!` bash 模式**：行首 `!cmd` 直接跑 shell（可选）。
> - **`#` 快速记忆**：作为 `/remember` skill / `mem write` 的输入态快捷入口（chovy 现有 `/mem`）。
> - **生成中消息排队（message queueing）**：busy 时 Enter = 入队，agent 结束后顺序消费；当前只保留 draft，未定义 busy 提交行为。
> - **生成中状态行 + `esc 中断`**：与 step-46/56 协同，流式期间常驻 `spinner + 已用时 + token/cost + esc 中断`。

## 产物

```
src/cli/
├── inputBoxV2.tsx        # 替换既有 inputBox.tsx 的导出
├── inputState.ts         # buffer / cursor / lines / mode（normal/search/paste-preview）
├── slashHint.tsx         # 斜杠补全提示
└── pasteDetector.ts      # 检测连续高速输入的 paste
```

## 实现要点

### 1. 状态管理

```ts
// src/cli/inputState.ts
export interface InputState {
  buffer: string;
  cursor: number;            // 字符偏移
  mode: "normal" | "search" | "pastePreview";
  searchQuery: string;       // mode=search 时的反向搜索 query
  searchMatch?: { entry: string; index: number };
}
```

`useReducer` 管理；reducer 纯函数（按键事件 → state diff）。

### 2. 多行渲染

InputBox v2 用 `wrapByDisplayWidth(buffer, cols - 2)`（step-33 stringWidth）切行：

```tsx
const lines = wrapByDisplayWidth(state.buffer, innerCols);
const cursorRow = computeCursorRow(state.buffer, state.cursor, innerCols);
const cursorCol = computeCursorCol(state.buffer, state.cursor, innerCols);
return (
  <Box flexDirection="column" borderStyle={theme.borderStyle} borderColor={theme.muted}>
    {lines.map((l, i) => (
      <Text key={i}>
        {i === cursorRow
          ? renderWithCursor(l, cursorCol)
          : l}
      </Text>
    ))}
  </Box>
);
```

`renderWithCursor` 在光标位置加 `▌`（盖在字符上用 inverse）。

### 3. Shift+Enter 换行 vs Enter 提交

step-34 keybinding：

- `Enter` → submit（除非 mode=search）；
- `Shift+Enter` → 在 cursor 处插入 `\n`。

部分终端不会区分 Shift+Enter（Windows ConHost）→ 提供 `Ctrl+J` 兜底（step-34 keybinding 注册 `input.newline` = `Ctrl+J`）。

### 4. 斜杠补全 hint

```tsx
// src/cli/slashHint.tsx
function SlashHint({ buffer }: { buffer: string }) {
  const slash = findActiveSlash(buffer);   // 支持行首 slash；普通正文里的 / 不触发
  if (!slash) return null;
  const head = slash.commandHead;
  if (!head) return null;
  const matches = searchSlashCommands(head, { includeAliases: true, includeDynamic: true, locale: getLocale() });
  if (matches.length === 0) return null;
  const top = matches[0]!;
  const theme = useTheme();
  return (
    <Box marginLeft={1}>
      <Text dimColor>{`→ /${top.name}`}</Text>
      {matches.length > 1 ? <Text dimColor>{` (+${matches.length - 1})`}</Text> : null}
      <Text color={theme.accent}>{` Tab 补全`}</Text>
    </Box>
  );
}
```

按 Tab 时把当前 slash head 替换成 `/${top.name} `，cursor 移到命令参数位置；如果命令有 `argsHint`，hint 行显示参数占位。
候选来自 `listSlashes(ctx)`：内置命令、`/<skill-name>`、plugin/workflow/MCP 命令都在同一列表里。搜索权重参考 cc-haha 的命令建议思路（命令名 > alias > 描述 > category > source），但实现使用 step-42 自研 fuzzy，不引 Fuse 等新依赖。

动态来源显示 source label：例如 `/my-skill :skill`、`/deploy :workflow`、`/db-query :mcp`；真正插入 InputBox 时只插入命令名本身，不插入 label。

### 5. 反向搜索（Ctrl+R）

`Ctrl+R` 进入 search mode：

```
(reverse-i-search)`xxx': /goal "fix bug"
```

每次 keypress 在 history 数组中从最后向前找含 query 的条目；ESC 退出搜索 + 还原 buffer；Enter 提交搜索结果作为新输入。

### 6. paste 检测

```ts
// src/cli/pasteDetector.ts
const PASTE_THRESHOLD_MS = 5;       // 间隔 < 5ms 的连续输入视作 paste
const PASTE_MIN_CHARS = 64;
let lastInputAt = 0;
let pasteBuf = "";
export function feedKey(ch: string, now: number): { isPaste: boolean; flushed?: string } {
  if (now - lastInputAt < PASTE_THRESHOLD_MS) {
    pasteBuf += ch;
    lastInputAt = now;
    return { isPaste: true };
  }
  // gap 后 flush
  let flushed: string | undefined;
  if (pasteBuf.length >= PASTE_MIN_CHARS) flushed = pasteBuf;
  pasteBuf = ch;
  lastInputAt = now;
  return { isPaste: false, flushed };
}
```

flushed 时 setMode("pastePreview") + 显示折叠占位 `[粘贴 142 字符]`，可按 Enter 直接提交（隐形包含原文）；
也可按 `Ctrl+E` 展开编辑。

### 7. 性能不变量（SMOOTH-3.1）

- 按键 dispatch 纯函数 reducer，**不**触发 fs / i18n 重新算；
- 所有 useMemo 缓存 wrap 结果（依赖 buffer + cols）；
- React.memo 包整个 InputBox v2，外部 props 仅当 disabled / busy 改变才重渲染；
- 100 ms 内连续 30 次按键不掉帧（smoke 验证）。

## 接口冻结 / 不变量

- 既有 InputBox props 接口（`disabled` / `history` / `onSubmit` / `onCancel` / `onCtrlC`）**字段名不变**；
- v2 在 props 上**追加**可选字段（`autoSlashHint?: boolean` 默认 true、`pasteDetect?: boolean` 默认 true）；
- replac 现有 `inputBox.tsx` export 时保留 `InputBox` 命名；旧测试 import 路径不变；
- paste 阈值常量写死，不进 config（防滥调）。

## 验收标准

- `bun run typecheck` 通过；
- 输入 `/g` → 右侧出现 `→ /goal Tab 补全`；按 Tab → 自动补 `/goal `；
- 输入 `/sum` → 命中 `/compact` alias `/summarize`；输入 `/tool` → 命中 `/tool-details`；
- 注册 bundled skill `verify` 后输入 `/ver` → 命中 `/verify :skill`；按 Tab → 自动补 `/verify `；
- Shift+Enter 换行 → 渲染两行；
- ↑ → 上条历史；Ctrl+R → 反向搜索 mode；
- 粘贴 200 字符 → 显示 `[粘贴 200 字符]`；按 Enter → 实际提交完整 200 字符；
- `scripts/smoke-step53.ts`：reducer pure unit + paste detector unit 全过；
- 输入 100 ms 内 30 字符 → react render < 50 ms。

## 风险

- **多行光标位置算错**：CJK 字符宽 2 → cursorCol 必须按 display width 算；用 step-33 helper 严格走。
- **paste 误判**：终端慢时正常打字也可能 < 5ms（极少）→ 阈值偏保守 + threshold ms 写死；用户嫌烦可关 `pasteDetect`。
- **Ctrl+R 与 Esc 冲突**：Esc 退出搜索时切回 normal mode，不冒泡到全局 `abort.run`；scope=input 隔离。
