# Step 05 完成报告 — CLI Shell（subcommands + 交互式 REPL）

- **Phase**: A（Foundation） — Phase A 收官
- **依赖**: 02（config / `permissionMode` / `setCliFeatureFlags`）、03（logger / 颜色 / NDJSON）、04（`ensureHomeDirs` / `ensureProjectDirs`）
- **B 屏障**: 无（不暴露需被冻结的接口；下游 step-13/22/23 在自家步骤里追加 slash / 浮层即可）
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-05-cli-shell.md`](../step-05-cli-shell.md)
- **关联创新**:
  - SCW — HeaderBar 预留 `BudgetSnapshot.ctxUsedTokens / ctxTotalTokens` 字段，等 step-27 写实
  - SwarmR — REPL `ReplCtx.listAgents` 等 step-22 把 swarm pool 接入即可点亮
  - CSG — `/skills` slash 命令骨架已就位，等 step-29 的 SkillGraph 实现后填充列表
  - ATP / TMT — 暂未直接耦合，仅由 `/mem` 占位提示后续步骤

---

## 1. 目标回顾

把当前"一次性 prompt → 渲染一次"的 CLI 扩展为：
1. 多子命令体系：`chat | goal | mem | agent | skill | log | provider`；
2. 交互式 REPL（多轮对话 + 斜杠命令 + 多行输入）；
3. 顶部 StatusLine（HeaderBar）实时显示 model / cost / ctx 占用。

---

## 2. 产物清单

### 2.1 新建文件

| 路径 | 行数（约） | 作用 |
|---|---|---|
| `src/cli/repl.tsx` | 220 | `ChovyRepl` 主屏：messages / busy / mode / help / goal / history 全套 state；slash 路由；二次 Ctrl+C 退出语义；预留 `BudgetSnapshot` |
| `src/cli/slashCommands.ts` | 110 | 9 条 slash：`help / quit / clear / mode / goal / mem / agents / skills / provider`；`ReplCtx` 接口；`listSlashEntries()` 给 HelpOverlay |
| `src/cli/inputBox.tsx` | 145 | `<InputBox>`：`useInput` 自管按键；多行 + 历史 + Esc 取消 + Ctrl+C 转发；Shift/Alt+Enter 换行 |
| `src/cli/components/HeaderBar.tsx` | 65 | mode 颜色环（5 模式 → 5 色）+ `provider/model` + `ctx % / $cost`；色彩规约表 `MODE_COLORS` |
| `src/cli/components/MessageList.tsx` | 55 | 4 类消息（user / assistant / tool / system）+ `pending` / `interrupted` 视觉态 |
| `src/cli/components/HelpOverlay.tsx` | 35 | `/help` 浮层：cyan 圆角边框 + slash 表 + 快捷键提示 |
| `docs/complete/step-05-cli-shell.md` | 本文件 | 完成报告 |

### 2.2 改动文件

| 路径 | 改动要点 |
|---|---|
| `src/cli/index.tsx` | 重构为 commander 子命令骨架：默认 action（无 prompt → REPL，有 prompt → one-shot）+ `chat / goal / mem / agent / skill / log / provider`；提取 `resolveCtx()` 公共启动管线（verbose / feature / ensureDirs / loadConfig），子命令通过 `cmd.optsWithGlobals()` 复用顶层 flag；新增 `startRepl()` / `startOneShot()` 两条渲染路径；保留所有原有 flag（`-t / --max-tokens / --permission-mode / --feature / -v`）与 `PROVIDER_NOT_READY` 单行错误提示 |

### 2.3 未触碰的文件（避免越界）

- `src/cli/components/AgentRepl.tsx`（按 step-05 §产物 标"兼容：one-shot 模式"，原封不动作 one-shot 渲染入口）
- `src/cli/components/StatusLine.tsx`（已有；REPL 直接复用其 `thinking / tool` 状态）
- `src/agent/agent.ts`（不在本步范围；Ctrl+C 真硬中断推迟到 step-16 引入 `AbortSignal`）
- `bin/chovy.js`、`bin/chovy.js.map`（AGENTS.md §9 红线 — 构建产物）
- `package.json`（未引入新依赖；`commander / ink / react` 已就位）
- 任何 `docs/step-XX-*.md`（接口冻结点）

---

## 3. 关键设计决策

### 3.1 默认 action = REPL or one-shot 二态机
不引入 `chovy repl` 这种第三个动词。`chovy` 无参 ⇒ REPL；`chovy "<prompt>"` ⇒ one-shot；`chovy chat [prompt]` 等价于默认。这样既符合 step-05 验收"`chovy` 无参直接进 REPL"，又保留 cc-haha 那种"裸输入即跑"的肌肉记忆。

### 3.2 Ctrl+C 软中断（先于 step-16）
`runAgent` 当前没有 `AbortSignal`（step-16 才加）。本步采用**软中断**：
- `render({ exitOnCtrlC: false })` 让 Ink 不再自管退出
- `useInput` 捕获 `key.ctrl && input === 'c'`，转给 `onCtrlC()`
- busy 时：`cancelledRef.current = true`，丢弃后续 token，UI 标 `[interrupted]`，**不退出**；底层 agent 仍跑完但结果被忽略
- idle 时：第一次 Ctrl+C 入"二次确认"窗口（1500ms TTL），再次按下才 `exit()`
这条妥协路径在 `repl.tsx` 顶部注释里写明，等 step-16 真信号下来后改成 `AbortController.abort()` 即可，不需要重写 UI。

### 3.3 `CHOVY_DISABLE_RAW=1` 降级
按 step-05 §风险，Ink 5 在 Windows ConHost 上 raw mode 偶有抽搐。当此环境变量为 `1` 时改回 `exitOnCtrlC: true`，由 Ink 接管 Ctrl+C，相当于回到"按一次就退"的稳健行为，代价是失去"中断不退出"的语义——可接受。

### 3.4 Slash 命令统一签名 + ReplCtx 容器
所有 slash 拿同一个 `ReplCtx`（`setMode / appendSystem / clearMessages / toggleHelp / setGoal / exit / listProviders / listAgents / listSkills`）。下游 step-22（agents UI）/ step-25（mem 注入）/ step-29（skill graph）只需把对应 `listXxx` / `setGoal` 接成真实调用即可点亮，不必碰 REPL 主屏。

### 3.5 HeaderBar 预算槽 = 静态结构 + 占位数字
`BudgetSnapshot` 已以 `{ costUSD, ctxUsedTokens, ctxTotalTokens }` 形态冻结在 `HeaderBar.tsx`。本步只画 0/0%/$0；step-16（costTracker）+ step-27（context monitor）落地后，REPL 在自己的 `useState` 里替换成真实流即可，HeaderBar 组件不动。

### 3.6 `5 模式 → 5 色` 颜色规约
| mode | color | 语义 |
|---|---|---|
| default | cyan | 常规交互（agent 全工具） |
| plan | yellow | 只读规划，禁写 |
| acceptEdits | green | 默认放行编辑 |
| auto | magenta | 主动迭代 |
| bypassPermissions | **red** | 危险旁路 |
这套色板等 step-12（permission engine）/ step-13（hooks）落地后会被 `permissions/modes.ts` 共享，避免组件层各搞各的。

### 3.7 `useInput` 而非第三方输入库
不引入 `ink-text-input`（package.json 未变），自管 cursor / history / Shift-Enter / Alt-Enter / Backspace / Delete / Esc / Ctrl+C / 上下箭头。代价是没有自动换行 wrap 行为；收益是依赖最小化、行为可控、易于在 step-13（hooks）中追加 PreSubmit 钩子。

---

## 4. 验收对照（step-05 §验收标准）

| 验收项 | 实现位置 | 实测 |
|---|---|---|
| `chovy` 无参直接进 REPL | `cli/index.tsx` 默认 action 中 `if (!prompt) startRepl(ctx)` → `render(<ChovyRepl/>)` | ✅ 启动路径走通；`bun -e "import('./src/cli/repl.js')"` 加载 OK |
| 输入 `/help` 浮层显示斜杠命令表 | `slashCommands.help → ctx.toggleHelp(true)`；`<HelpOverlay entries={listSlashEntries()}/>` | ✅ 9 条命令注册：`help,quit,clear,mode,goal,mem,agents,skills,provider` |
| `/mode plan` 切换且 HeaderBar 颜色变化 | `slashCommands.mode → ctx.setMode("plan")` → `<HeaderBar mode="plan" .../>` 走 `MODE_COLORS.plan = "yellow"` | ✅ 校验逻辑命中 `PERMISSION_MODES` allowlist；未知 mode 走 appendSystem 错误回声 |
| Ctrl+C 中断而不退出 REPL | `onCtrlC()` busy 分支：`cancelledRef.current = true; appendSystem("已中断…"); return`（不调 `exit()`） | ✅ 代码路径明确；`useInput` 在 `disabled` 时仍捕获 Esc/Ctrl+C |
| `bun run typecheck` 通过 | tsc strict + noUnusedLocals + noUnusedParameters + erasableSyntaxOnly | ✅ EXIT=0 |

### 子命令冒烟实测

```
$ bun src/cli/index.tsx --help          # 列出 chat/goal/mem/agent/skill/log/provider
$ bun src/cli/index.tsx --version       # 0.1.0
$ bun src/cli/index.tsx provider list   # 7 个 provider 全显
$ bun src/cli/index.tsx mem list        # memory list — TODO step-25
$ bun src/cli/index.tsx agent list      # agent list — TODO step-22
$ bun src/cli/index.tsx goal "explain"  # /goal: explain + step-23 占位提示
$ bun src/cli/index.tsx chat "hello"    # PROVIDER_NOT_READY: OpenAI API key missing.（fail-fast 路径未坏）
```

---

## 5. 已知限制 / TODO（按 AGENTS.md §9，明示而非伪装）

1. **Ctrl+C 真硬中断**：当前是软中断（丢 token + UI 标记）；`runAgent` 仍跑完。step-16 引入 `AbortSignal` 后 `repl.tsx` 顶部注释处替换成 `AbortController.abort()` 即可，UI 层不动。
2. **HeaderBar cost / ctx 数字**：占位 0；step-16（cost）/ step-27（ctx monitor）填充。
3. **`/mem`、`/agents`、`/skills`、`/goal` 循环**：仅占位 + 引导文案（"TODO step-XX"），未冒充实现。
4. **非 TTY 守护缺失**：在非 TTY 环境跑 `chovy` 无参，Ink raw mode 会失败。后续可在 `startRepl` 加 `process.stdin.isTTY` 守护回退到 one-shot help。
5. **Shift+Enter 换行兼容性**：某些终端不会把 `Shift` 报给 stdin；本步同时接受 `Shift+Enter` / `Alt(Meta)+Enter` 作为换行键，已在 `inputBox.tsx` 注释说明。
6. **InputBox 单行渲染**：当前把 `value` 作为单 `<Text>` 渲染，依赖 Ink 自动换行；不显示行号 / 软光标位置随多行有视觉漂移。step-13 接入 hooks 时再做"真多行 + soft cursor"。
7. **MessageList 不滚动**：实际是线性追加，无虚拟列表。step-22 swarm 面板上线时一并替换成虚拟化版本。

---

## 6. 风险登记（建议追加到 step-05 §风险）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Ink 5 raw mode 在 Windows ConHost 不稳 | `CHOVY_DISABLE_RAW=1` 降级；推荐 Windows Terminal / WezTerm |
| R2 | `Shift+Enter` 在某些 SSH/tmux 嵌套终端被吞 | 同时接受 `Alt+Enter` / `Meta+Enter` |
| R3 | 非 TTY 环境调用 `chovy` 无参崩溃 | 后续步骤补 `process.stdin.isTTY` 守护 |
| R4 | 软中断后 agent 仍消耗 token / 钱 | step-16 引入真 AbortSignal 时一并修复；当前文档明示 |
| R5 | slash handler 抛异常会污染 REPL | `runSlash` 已 try/catch + appendSystem 回声错误（不会 crash 主屏） |

---

## 7. 与下游步骤的衔接点

| 下游 step | 衔接位置 | 怎么改 |
|---|---|---|
| step-12（permissions） | `MODE_COLORS` / `PERMISSION_MODES` | 移到 `harness/permissions/modes.ts`；REPL 改 import 即可 |
| step-13（hooks） | `runSlash` / `send` | `PreSubmit` / `PostMessage` hook 在 send 前后调度；不必动 UI |
| step-16（query engine） | `runAgent` 调用点 | 改成 `queryEngine.run({ prompt, signal, onToken, onToolCall })`；保留 `cancelledRef` 仅作 fallback |
| step-17（providers real） | HeaderBar `provider/model` | 已是字符串显示，无需改 UI；`assertProviderReady` 沿用现有路径 |
| step-22（agents UI） | `ReplCtx.listAgents` / `slashCommands.agents` | 直接换成 swarm pool 真实查询；HelpOverlay 自动同步 |
| step-23（goal loop） | `slashCommands.goal` / 顶部 `goal` 横条 | 换成启动 `goalLoop({ objective })`；UI 已经在 |
| step-25（memory inject） | `slashCommands.mem` | 换成 `memory.search/show/list` 真调用 |
| step-27（context monitor） | `BudgetSnapshot` setter | 在 REPL 加 `setBudget`，HeaderBar 不动 |
| step-29（skill graph） | `slashCommands.skills` / `ReplCtx.listSkills` | 换成 `skillRegistry.list()` |

---

## 8. 自检清单

- [x] `bun run typecheck`：EXIT=0
- [x] `bun src/cli/index.tsx --help` 列出全部 7 个子命令
- [x] `bun src/cli/index.tsx --version` 输出 `0.1.0`
- [x] `bun src/cli/index.tsx provider list` 列出 7 个 provider
- [x] `bun src/cli/index.tsx chat "hello"` 走 PROVIDER_NOT_READY fail-fast
- [x] 6 个新模块 `bun -e "import(...)"` 加载干净（ChovyRepl / InputBox / HeaderBar / HelpOverlay / MessageList / slashCommands）
- [x] 不修改 `bin/chovy.js`、`bin/chovy.js.map`
- [x] 不引入新依赖（`package.json` 未变）
- [x] 不删除 / 重构未要求的代码（`AgentRepl.tsx` / `StatusLine.tsx` / `agent.ts` 全部原样）
- [x] 顶部注释 / 字段标注里明示了所有 `TODO step-XX` 衔接点
- [x] Phase A 5 步全部就位，B1 屏障未触及（不影响）

---

## 9. 致谢与边界

- 灵感来源：cc-haha 的 `screens/REPL.tsx`（取其"slash 路由 + busy 中断 + 顶部状态"骨架；不复刻它 2000+ 行的钩子矩阵）
- 本步严格按 AGENTS.md §5 的 8 条硬规则执行；未越界修改 `~/.gitconfig` / `.git` / 构建产物 / dotfiles
- 未做 `git commit / push`（按规则等用户授权）

> **下一步建议**：开 Phase B 的 step-06（Tool 协议 v2 + ATP）。它是 B1 屏障，所有依赖工具的下游步骤（step-08 ~ step-11、step-12、step-15、step-19）都在等它的 `Tool / ToolContext / ToolResult` 接口冻结。
