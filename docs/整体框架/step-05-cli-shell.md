# Step 05 — CLI Shell（subcommands + 交互式 REPL）

**Phase**: A | **依赖**: 02,03 | **可并行**: ✅ | **估时**: 5h

## 目标

把当前"一次性 prompt → 渲染一次"的 CLI（`src/cli/index.tsx`）扩展为：

1. 多子命令体系：`chat | goal | mem | agent | skill | log | provider`；
2. 交互式 REPL（多轮对话 + 斜杠命令 + 多行输入）；
3. 顶部 StatusLine 实时显示 model / cost / ctx 占用。

## 产物

```
src/cli/
├── index.tsx              # 重构：subcommand 路由
├── repl.tsx               # 新：交互式 REPL 主屏
├── slashCommands.ts       # 新：/help /goal /mem /agents /clear /quit ...
├── inputBox.tsx           # 新：多行输入（支持 Esc 编辑历史）
└── components/
    ├── AgentRepl.tsx      # 兼容：one-shot 模式
    ├── StatusLine.tsx     # 已存在，扩展
    ├── HeaderBar.tsx      # 新：顶部状态条
    ├── MessageList.tsx    # 新：滚动消息列表
    └── HelpOverlay.tsx    # 新：?/help 浮层
```

## 实现要点

### 1. Commander 子命令骨架

```ts
program.command('chat [prompt]').action(...)         // 默认子命令；无 prompt 进入 REPL
program.command('goal <objective>').action(...)      // 进入 /goal 长程模式
program.command('mem').command('list').action(...)
program.command('mem').command('show <key>').action(...)
program.command('mem').command('search <query>').action(...)
program.command('agent').command('list').action(...) // 列出运行中子 agent
program.command('skill').command('list').action(...)
program.command('log').command('tail').action(...)
program.command('provider').command('list').action(...)
```

### 2. REPL 主循环

```tsx
// repl.tsx
function ChovyRepl({ initialProvider, initialModel }) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<BudgetSnapshot>(...);
  const [mode, setMode] = useState<PermissionMode>('default');

  async function send(text: string) {
    if (text.startsWith('/')) return runSlash(text);
    setBusy(true);
    await queryEngine.run({ prompt: text, ...callbacks });
    setBusy(false);
  }

  return (
    <Box flexDirection="column" height="100%">
      <HeaderBar mode={mode} budget={budget} />
      <MessageList messages={messages} />
      {busy ? <StatusLine ... /> : <InputBox onSubmit={send} />}
    </Box>
  );
}
```

### 3. 斜杠命令注册

```ts
type SlashHandler = (args: string, ctx: ReplCtx) => Promise<void> | void;
const slashes: Record<string, { handler: SlashHandler; help: string }> = {
  help: { handler: showHelp, help: '显示帮助' },
  quit: { ... },
  clear: { ... },
  mode: { handler: setMode, help: '切换权限模式' },
  goal: { handler: setOrShowGoal, help: '设置长程任务' },
  mem: { ... }, agents: { ... }, skills: { ... },
  // step-23/29 后续追加
};
```

### 4. 输入框

- 支持上下方向键浏览历史；
- Shift+Enter 换行，Enter 提交；
- Esc 取消正在发送的请求；
- Ctrl+C 二次确认退出。

### 5. 退出语义

- one-shot：完成即退；
- REPL：仅 `/quit` 或两次 Ctrl+C 退出。

## 验收标准

- `chovy` 无参直接进 REPL；
- 输入 `/help` 浮层显示斜杠命令表；
- 输入 `/mode plan` 切换模式且 HeaderBar 颜色变化；
- 输入 `Ctrl+C` 正在执行的 agent → 中断而不退出 REPL。

## 参考源

- `cc-haha/src/cli/`、`cc-haha/src/components/`（菜单结构、HeaderBar）
- `cc-haha/src/screens/`

## 风险

- Ink 5 的 stdin raw mode 在 Windows ConHost 不稳定 → 推荐 Windows Terminal；提供 `CHOVY_DISABLE_RAW=1` 降级。

## 验收追补（2026-06-18）

- 所有子命令 action 都必须走统一 `resolveCtx()` 启动管线，确保 feature flag、permission mode、`CHOVY_HOME` 与 config 校验行为一致。
- 非 TTY 下无参 `chovy` 必须拒绝进入 REPL 并输出明确 `CONFIG_INVALID`，避免 Ink raw-mode stack 泄露到用户界面；非交互场景使用 `chovy chat "..."`。
- `resolveCtx()` / commander 顶层 catch 捕获 `ChovyError` 时必须把 Error 对象原样传给 logger，不能先转为 `.message` 字符串；否则 malformed config 等路径会丢失 `chovy.error: <CODE>` 规范输出。
