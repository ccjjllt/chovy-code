# TUI 计划评审：对标 claude-code 的优化项 + 测试现状（2026-06-20）

> 本文是对 `docs/tui/`（step-31..60）现有计划的一次**评审记录**，不是新计划合约。
> 目标：① 在「对标 claude-code 的使用体验与功能丰富度」这个标准下，指出现有计划**可优化 / 应改动**的点；
> ② 记录**现有测试脚本的过时与盲区**（已实跑验证）。
>
> 本文只**注记建议**，不改动 step 文档的接口冻结结论；具体落地仍需在对应 step 文档里把建议转成产物/验收。
> 阅读前置：`README.md` / `architecture.md` / `innovations.md` / `command-skill-coverage.md`。

---

## 0. 一句话结论

现有计划在 **视觉与命令容器**（吉祥物 / Ctrl+P 面板 / 主题 / i18n）上很完整，
但在 **claude-code 真正赖以成名的「人机协作交互面」** 上有明显缺口：

- **后端已经具备**交互式权限审批、`ask_user_question`、`todo_write`、文件 `+/-` diff 追踪，
- **但 step-31..60 没有任何一步为它们做 TUI 界面**（`ask_user_question` 甚至在源码里明确等待一个被推迟的 `AskUserOverlay`）。

同时把 **5 步（36–40）投在 GIF 吉祥物**上。要对标 claude-code 的体验，应**重配优先级**：先补齐协作交互面，再做吉祥物等差异化装饰。

测试侧：`bun run demo` 当前在 `main` 上**已经是红的**（断言过时），且整套 smoke **完全不覆盖任何 TUI 渲染**——计划是建立在一个「看起来绿、实际测不到 UI」的基线上的。

---

## 1. 已验证的测试现状（过时 / 盲区）

> 下列结论均已在本机 `bun run smoke` / `bun run demo` 实跑确认，不是推测。

### 1.1 `bun run demo` 当前直接失败（基线已红）

- `scripts/demo.ts:45` 的断言写死 `/8 passed, 0 failed/`。
- `scripts/smoke.ts` 现在有 **11 个 case + 1 个 bin 校验 = 12 项**，实跑输出 `=== 12 passed, 0 failed ===`。
- 因此 demo 第 3 步「TMT + mock E2E」正则匹配失败，`bun run demo` **退出码 1**。

**影响**：`step-59` 把 demo 当成「既有 5 条创新主线已通过、在其上追加 5 条 TUI 主线」的绿色基线，
但这个基线现在是红的。计划落地前必须先承认/修复这个事实。

**建议（仅注记，不在本次改代码）**：
- 把 demo 对 smoke 的断言从写死数字改成**与数量无关**的判定：`/\d+ passed, 0 failed/` + 退出码 0；
- 或让 demo 直接读 smoke 退出码，不解析 "N passed" 文本。
- 这条要写进 `step-59` 的产物清单（demo 重构）里，否则每加一个 smoke case 都会再次把 demo 打红。

### 1.2 整套 smoke 完全不覆盖 TUI 渲染

- `scripts/smoke.ts`（"Step-30 integration smoke"）只跑 **CLI 子命令**：`--version` / `--help` / `config` /
  `provider list` / `skill list` / `mem write|search` / `chat`（mock）。
- `architecture.md §7` 明确规定 smoke = `Bun.spawn` 子进程 + stdout 正则，**禁止 import/render Ink 组件**
  （"不允许直接 import Ink 组件 render，避免 Ink 在 CI 卡死 stdin"）。
- 结论：**今天 `src/cli/` 下整个交互层**（`repl.tsx` / `HeaderBar` / `MessageList` / `inputBox` /
  `SwarmPanel` / `GoalPanel` / `HelpOverlay` / `StatusLine`）**没有任何自动化测试**。
  step-31..60 计划新增的 companion / palette / settings / welcome 在同一规则下也将**无渲染级验证**。

**影响**：要对标 claude-code 的「使用体验」，恰恰是渲染层（光标、折叠、diff、焦点环、overlay 互斥）最容易回归，
而当前测试策略对此**结构性失明**。"smoke 全绿" 不等于 "TUI 没坏"。

### 1.3 计划内部自相矛盾：§7 禁渲染 vs 多个 step 要求渲染断言

- `architecture.md §7`：禁止 render Ink。
- 但 `step-45` 验收：「渲染包含 `chovy-code v` 字符串」；
  `step-46` 验收：「渲染 snapshot 含全部 chips；resize 到 50 → 仅含 mode chip」；
  `step-54` 验收：「mock messages.length=100 → 渲染只 mount 30 个 MessageRow（spy）」。
- 这些都需要**真正渲染组件**（`ink-testing-library` 式 `render()` + lastFrame/spy），
  而 `ink-testing-library` **不是当前依赖**，且红线 #13「不引入新 npm 依赖」会挡住它。

**建议（注记）**：在 `architecture.md §7` 与各 step 之间**二选一并写清**：
1. **要么** 允许一个受控的「组件测试」通道（评估 `ink-testing-library`，按红线 #13 在 step 风险段显式说明理由+体积），
   且只在本地/CI 的非交互渲染里用，不进生产；
2. **要么** 把 step-45/46/54 等验收**改成纯逻辑断言**：把可测逻辑（`chooseChips()` 折叠算法、
   `selectVisible()` 虚拟化、welcome 显隐条件、wrap/cursor 计算）抽成纯函数单测，渲染只做人工/E2E 抽查。
   推荐方案 2（不破红线、可在 CI 跑），但必须把"渲染 snapshot"这类措辞从验收里删掉，避免写不出来。

### 1.4 step-59 引用了不存在、且可能违规的 CLI 子命令

- `step-59` demo/coverage 段使用 `chovy palette list`、`chovy palette coverage --json`。
- 这些**子命令今天不存在**；更重要的是它们会**新增 CLI surface**，与红线 #14
  「`bin/chovy.js` 字节级一致 / 外部行为完全不变」存在张力。
- 覆盖率验收（`commandEquivalents>=72` / `bundledSkills>=15`）是 Phase L/P 的硬门槛，却依赖一个尚未定义、可能违规的入口。

**建议（注记）**：在 step-43/44/59 里明确覆盖率验收的**载体**——
是新增 `chovy palette coverage`（则需在 §14 例外清单里登记），
还是用一个**只读的 smoke 内部 API**（`getCommandCoverage()` 直接 import 计数，不新增 CLI 子命令）。推荐后者。

### 1.5 step-59 的 `smoke-tui.ts` 聚合方式脆弱

- 设计是 `for id of STEPS: await import("./smoke-${id}.ts")`，**靠 import 副作用执行**。
- 问题：① import 缓存 → 同一 smoke 无法重复跑；② 子 smoke 多用 `Bun.spawn` 串行 ×27，正是文档自己警告的 150s 超时；
  ③ 子 smoke 用 `process.exit()` 还是 `throw` 行为不一致，聚合器无法稳定判定单步失败。

**建议（注记）**：把每个 `smoke-stepXX.ts` 改成**导出一个 `run(): Promise<Result>` 函数**（而非 import 即跑），
聚合器并发调度（≤5）并收集结果；这与 §7「5s 单文件 / 30s 总时长」目标自洽。

### 1.6 既有 step-04..29 smoke 与真实形态的关系

- 它们测的是**后端/CLI 行为**（fs、permission、hook、swarm、memory、context、skill），这些是真实的、有价值的。
- 但它们的存在容易造成"测试很多"的错觉——**它们一行都没碰交互式 TUI**。
- 评审结论：既有 smoke **没有过时到「测错东西」**，但它们**与 TUI 第二阶段的验收目标基本无关**；
  TUI 阶段需要一套**新的、面向交互层的验证策略**（见 1.3 的方案 2），不能复用 spawn+regex 来"证明 UI 好用"。

---

## 2. 对标 claude-code 的优化项（按优先级）

> 评判标准：claude-code 的体验核心是 **「代理在你眼皮底下安全地改代码」**——
> 交互式权限审批、可读的 diff 预览、计划/待办可视、被问到时能选、随时可中断、`@` 引文件、`!` 跑命令。
> 现有计划在「装饰与容器」上完整，在这条主线上欠缺。

### 2.1 【最高】为已存在的后端交互工具补 TUI 界面

源码事实（已核对）：

| 后端能力 | 源码 | 现状 | 计划缺口 |
|---|---|---|---|
| `ask_user_question` | `src/tools/meta/askUserQuestion.ts` | 注释**明确**："需要 step-22 的 Ink `AskUserOverlay` 提供回调"，否则 `INTERNAL` 拒绝 | step-31..60 **没有** AskUserOverlay |
| `todo_write` | `src/tools/meta/todoWrite.ts` | 发 `todo.wrote` 遥测，注释说"供 step-22 在状态行展示进度" | 没有 Todo/计划清单面板 |
| 6 层权限引擎 | `src/harness/permissions/engine.ts` | L6 "ask → prompt user (TTY+askUser)" 需要交互审批 UI | 权限只在 HeaderBar 当作 **chip 展示**，**没有**交互式审批 prompt |
| 文件 `+/-` diff 追踪 | `src/tools/fs/fileHistory.ts` | 记录每文件 size/±lines，注释说"供 step-22 状态行/diff" | step-54 只折叠工具块，**没有** diff 预览 |

**这是本次评审最重要的结论**：claude-code 体验的 4 个支柱（审批 / 选择 / 待办 / diff）后端都已就绪，
计划却一个 UI 都没排，反而把 5 步投给吉祥物。建议**新增/提前**以下界面（可作为 Phase O 之前的高优先 step，或重排现有编号）：

1. **AskUserOverlay**（解锁 `ask_user_question`，今天它在非交互/无 UI 时直接拒绝）——
   1–4 题、每题 2–4 选项 + "Other" 自由文本，键盘选择，结果回灌 callback。**这是 backend 已经在等的 UI，应最先做。**
2. **PermissionPrompt**（接 permission engine L6 ASK 分支）——inline 显示「将执行 X，允许？是/否/本会话总是」，
   对标 claude-code 的逐次审批；与 `acceptEdits`/`plan`/`auto` 模式联动。
3. **TodoPanel / 计划清单**（消费 `todo.wrote`）——把 agent 维护的待办渲染成可读 checklist（claude-code 的核心可视化之一）。
4. **DiffView**（消费 fileHistory + 工具结果）——编辑类工具结果展开为带色 `+/-` diff，与 PermissionPrompt 串联成"先看 diff 再批准"。

### 2.2 【高】重新平衡吉祥物的投入

- 现状：step-36..40 共 5 步 ~17h 给 GIF 解码 / 帧缓存 / 状态机 / 集成 / 偏好。
- claude-code 是**极简、信息密集**的专业工具，没有吉祥物；动图反而可能与"专业感/dense"目标相悖，
  并和 MessageList / InputBox 抢终端高度（红线 8 已在防这点）。
- **建议（注记）**：
  - 把吉祥物压缩为 **2–3 步**（解码+渲染合并、播放器+状态机合并、集成），把省下的预算转给 §2.1 的 4 个界面；
  - 默认策略再克制一点：**欢迎屏可有 GIF，主屏常驻 companion 改为 opt-in**（默认只在 busy/done/error 时短暂提示，或纯文字状态），
    `CHOVY_NO_COMPANION` 之外再加一个 `config.tui.companion.persistent: false` 默认值；
  - 吉祥物保留为**差异化亮点**，但不应排在 §2.1 协作交互面之前。

### 2.3 【高】InputBox v2（step-53）补齐 claude-code 的输入模式

step-53 现在只覆盖 `/` slash 补全 + paste 折叠。claude-code 的输入区还有：

- **`@` 文件引用 + 模糊文件选择器**：claude-code 最核心的上下文附加方式。计划完全没有 `@` mention。
  **强烈建议**在 step-53 增加 `@path` 触发文件 fuzzy picker（复用 step-42 的模糊搜索 + fs 列举），插入后作为上下文引用。
- **`!` bash 模式**：行首 `!cmd` 直接跑 shell（claude-code 有）。计划未覆盖；可作为可选项。
- **`#` 快速记忆**：claude-code 用 `#` 快速写 memory；chovy 有 `/mem` 与 `remember` skill，可考虑 `#` 作为 `/remember` 的输入态快捷入口。
- **生成中排队消息（message queueing）**：claude-code 允许 busy 时继续输入并排队。step-53 只保留 draft，未定义 busy 期间提交行为。建议明确：busy 时 Enter = 入队，结束后顺序消费。

### 2.4 【中】生成中状态行 + 可中断提示

- claude-code 在生成时常驻一行：`⠋ 思考中… (12s · 1.2k tokens · esc 中断)`。
- 现有计划：step-56 有 spinner、step-46 有 chips、§9 红线提到 `esc` 但分散；**没有一个"生成中实时状态 + 中断提示"的明确产物**。
- **建议（注记）**：在 step-46 或 step-56 里把它定为显式组件/验收：流式期间显示 spinner + 已用时 + token/cost + `esc 中断`，
  接既有 abort 通道（AGENTS.md §9 取消独立 AC）。

### 2.5 【中】重新权衡 Ctrl+P 面板 vs `/` slash 菜单的优先级

- claude-code 的**主命令入口是 `/` slash 菜单**，不是 VSCode 式 Ctrl+P 命令面板（Ctrl+P 更像 MiMo/VSCode 范式）。
- 现有计划把 Phase L（41–44 共 4 步）几乎全压在 Ctrl+P 面板上，`/` 自动补全只在 step-53 顺带做。
- **建议（注记）**：把「`/` slash 菜单的 claude-code 级体验」（分组、描述、argsHint、fuzzy、即时预览）提到**与 Ctrl+P 同等或更高**优先级——
  因为这是 claude-code 用户**默认会用**的入口；Ctrl+P 作为增益保留即可。两者共享 registry 的设计（architecture §3）是对的，应继续。

### 2.6 【中】Plan 模式的"出示计划→批准"流程

- HeaderBar 有 `plan` 模式 chip，但 claude-code 的 plan 模式有**专门的「展示计划 + 批准/拒绝」交互**（类似 ExitPlanMode）。
- 现有计划只把 plan 当作权限模式着色，没有计划展示/批准 overlay。
- **建议（注记）**：与 §2.1 的 PermissionPrompt 一起设计一个 plan-review overlay；plan 模式下 agent 产出计划→用户批准后才允许切到执行。

### 2.7 命令覆盖率的"真实性"风险（command-skill-coverage）

- 覆盖文档要求 Session/transcript 组 ≥13（`/resume` `/rewind` `/branch` `/timeline` `/diff` …）。
- 但 `src/` 中**未见独立的会话/transcript 持久化层**（搜索 session/resume/rewind 命中的多是 checkpoint/goal，而非聊天会话存储）。
- 风险：为凑满 `commandEquivalents>=72`，这些命令可能以"预填/占位"形式注册——而覆盖文档 §3 本就禁止计数纯占位。
- **建议（注记）**：在 `command-skill-coverage.md` 里**显式加一条**：Session/transcript 组计数的前置是**真实存在 transcript 持久化后端**；
  后端缺失时这些命令必须 `hidden`/`enabled=false` 且**不计数**，并在 step-44/59 的 `nonCounted` 里列出原因（reason=`backend-missing`）。否则 72 这个数会"虚高"。

---

## 3. 不需要改、已经做得好的部分（避免过度优化）

- **i18n 中文优先 + MiMo 分层**：是相对 claude-code 的**差异化优势**，保留。
- **主题系统**（紫蓝 + 4 备选 + 自定义 + 持久化）：比 claude-code 更丰富，保留。
- **CSG skill 图**（requires/provides/conflicts/budget）：是 chovy 独有的强项，保留，不要为"对齐 cc-haha 数量"而退回平铺。
- **CtxChip + SCW 上下文压力**：已对齐 claude-code 的"上下文剩余/自动压缩"理念。
- **降级兜底**（`CHOVY_NO_TUI` / `NO_PALETTE` / `NO_COMPANION` / `NO_ANIM`）：escape hatch 设计正确，保留。
- **slash 与 palette 共享单一 registry**（architecture §3）：方向正确，是避免双源漂移的关键，保留。

---

## 4. 给落地者的 TODO（把建议转成 step 改动时）

> 本文不改 step 接口冻结结论。真正落地时，请按下表把建议写进对应 step 文档的「产物/验收/风险」，再实现。

| 建议 | 落到哪个 step 文档 | 动作类型 |
|---|---|---|
| demo 断言改为数量无关 | step-59 | 修产物（demo 重构） |
| §7 渲染矛盾二选一（推荐纯逻辑单测） | architecture §7 + step-45/46/54 验收 | 改验收措辞 |
| 覆盖率载体（不新增 CLI 子命令） | step-43/44/59 | 改产物 |
| smoke-tui 改 `run()` 导出 + 并发 | step-59 | 改产物 |
| AskUserOverlay（解锁 ask_user_question） | 新增 step（建议插在 Phase K/O 之前）| 新增 |
| PermissionPrompt + DiffView | 新增 step / 扩 step-54 | 新增/扩展 |
| TodoPanel | 新增 step / 扩 HeaderBar 状态区 | 新增 |
| 吉祥物压缩为 2–3 步 + 主屏 opt-in | step-36..40 + innovations | 重排/降权 |
| `@` 文件引用、`!` bash、`#` 记忆、消息排队 | step-53 | 扩产物 |
| 生成中状态行 + esc 中断 | step-46 / step-56 | 显式产物 |
| `/` slash 菜单提到与 Ctrl+P 同等优先级 | README §3 调度 + step-53/44 | 调权重 |
| Plan 模式批准 overlay | 新增 step（与 PermissionPrompt 同批）| 新增 |
| Session 组计数需 transcript 后端 | command-skill-coverage §3 | 加约束 |
