# Phase B 验收追补报告（step-06 → step-11）

> 验收日期：2026-06-18
> 范围：`docs/step-06-tool-protocol-v2.md` → `docs/step-11-meta-tools.md`、`docs/complete/step-06/07/08/09/10/11-*`、`源码解析.md`、Phase A/B1 屏障追补项
> 结论：B1 屏障接口稳定可供下游依赖；本轮修复了 4 个跨 step 的真实问题（其中 1 个是 B1 屏障内 telemetry 双计数、1 个是 ctx 未注入导致 step-11 设计意图无法生效、1 个是 AgentRole 类型分裂、1 个是 bash AbortSignal 未接）。

---

## 1. 依据

- `docs/README.md` / `docs/architecture.md` / `docs/innovations.md`
- `docs/step-06-tool-protocol-v2.md` … `docs/step-11-meta-tools.md`
- `docs/complete/step-06-07-acceptance.md` / `step-08-fs-tools.md` / `step-09-bash-tool.md` / `step-10-web-tools.md` / `step-11-meta-tools.md`
- `源码解析.md`（cc-haha 工程模式参考；只取分层、权限硬边界、单槽 hint、`EndTruncatingAccumulator` 双窗，**未**复刻 GrowthBook、TEAMMEM、Docker/VM sandbox、Buddy）

---

## 2. 修复项

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| **B1** | `tool.call` telemetry 双重计数：agent loop 已经统一 emit，但 `bash` / `web_fetch` / `web_search` / `ask_user_question` / `skill` / `agent` 自己又 emit 一次，导致每次工具调用产出 2 条事件 | step-27 上下文阈值监控、`chovy log tail` 计数全部翻倍；step-11 完成报告自身记录了"`todo_write` 例外不双发"——本质上承认了双发是 bug | 在 `bash.ts` / `web/fetch.ts` / `web/search.ts` / `meta/{ask,skill,agent}UserQuestion.ts` 删除 16 处自发 `emitTelemetry({type:"tool.call",...})`；保留 `agent loop wrapper` 为唯一发射点（与 step-03 telemetry events 冻结面一致）。同时移除每个文件顶部不再使用的 `import { emitTelemetry } from "../../telemetry/index.js"`。 |
| **B2** | agent loop 调 `tool.run(parsed.data)` 时**完全不传 ctx**，导致 step-11 的 `ctx.session.todoList` / `ctx.askUser` / `ctx.spawnSubAgent`，以及 step-09/10 的 `ctx.abortSignal` 全部走 fallback / no-overlay / stub 路径——step-11 设计意图（"step-16 接 ctx 后无须改本步代码即可生效"）在 step-16 没动手前永远生效不了 | meta 工具在 REPL 中也不能正常工作；ask_user_question 在交互 REPL 仍走 `INTERNAL → step-22`；bash 不能响应 Ctrl-C；web_fetch 无法被 agent abort | `src/agent/agent.ts` 在 `runAgent()` 入口构造**最小 ToolContext**：`cwd`、`abortSignal`（由 `AgentOptions.abortSignal` 注入，缺省给一个不会触发的 signal）、`logger`、`config = loadConfig()`、`sessionId = agentId`、`projectId = deriveProjectId(cwd)`、`session = { todoList: [] }`、`askUser`、`isInteractive`（缺省 `() => process.stdin?.isTTY`）。`permissions` / `hooks` 仍是占位 `{}`（step-12/13 owns）。`AgentOptions` 同时新增 `abortSignal` / `askUser` / `isInteractive` 三个可选字段，CLI / REPL 可在不破坏现有调用面的前提下逐步接入。`tool.run(parsed.data, ctx)` 替换原 `tool.run(parsed.data)`。 |
| **B3** | `AgentRole` 在 `src/types/agent.ts` 与 `src/telemetry/events.ts` 各定义一份且字面量分裂：前者 `"explorer"/"planner"/"verifier"`，后者 `"explore"/"plan"/"verify"`。`ROLE_AFFINITY`（step-07）走前者，agent.ts 与 telemetry sink 间发 `role: "main"` 暂时撞库存活——但 step-19 真实化时会编译失败，且 step-27 监控 + step-07 telemetry 不能交叉关联 | 类型分裂 + 未来步骤接通时整集报错 | `src/telemetry/events.ts` 删掉本地 `AgentRole` 字面量，改为 `export type { AgentRole } from "../types/agent.js"`，并 `import type { AgentRole }` 用于 `TelemetryEvent` 联合体。**单源**改回 `src/types/agent.ts`。 |
| **B4** | `bashTool.run()` 构造的 `ExecOptions` 没有把 `ctx?.abortSignal` 传给 `execShellCommand` —— `ExecOptions.abortSignal` 字段早就在 type 上预留好了，但 `run()` 始终传 `undefined`；agent 取消信号在 bash 子进程里完全失效 | bash 长任务无法被 agent abort | `bash.ts` 把 `run()` 形参从 `(args)` 改为 `(args, ctx?)`，`cwd = args.cwd ?? ctx?.cwd ?? process.cwd()`，`execShellCommand` 调用追加 `abortSignal: ctx?.abortSignal`。删除内部 2 处 `emitTelemetry({type:"tool.call"...})`（B1 配套）。 |

四项均严格遵守 AGENTS.md §5/§9：
- 未修改 `~/.gitconfig` / dotfiles / `.git/` / `.chovy/secrets/`；
- 未在 git 命令上加 `--no-verify`；
- 未 force push / `rm -rf`；
- 未引入新依赖；
- 未修改 `bin/chovy.js` / `bin/chovy.js.map`；
- 未修改 step-12/13/16/18/22/29 的接口面（B1 屏障保持冻结）；
- `ToolContext.session` / `askUser` / `isInteractive` 在 step-11 已是 *可选* 字段（追加于 step-11，本步只是真接它们），未破坏 step-06 调用方。

---

## 3. 实测验收

### 3.1 类型检查

```
$ bun run typecheck
$ tsc --noEmit
(no output, EXIT=0)
```

### 3.2 现有冒烟脚本（全部回归）

| 脚本 | 结果 |
|---|---|
| `scripts/smoke-step-04.ts` | PASS（20 项全 ok） |
| `scripts/smoke-step07.ts`  | PASS（6 个 ATP 用例 + tools.described×6） |
| `scripts/smoke-fs-tools.ts` | PASS（16 条 fs 断言） |
| `scripts/smoke-step09.ts`  | PASS（25/25：rm-rf deny、git push ask、PowerShell 路径、auto-bg、AST、双窗截断、hint 单槽、命令分类） |
| `scripts/smoke-step10.ts`  | PASS（14/14：htmlToMd × 6、私网拒绝 × 4、search backend 拒绝、ATP lean/full × 2） |
| `scripts/smoke-step11.ts`  | PASS（45/45：注册 × 4、todo 合并/in_progress 强制/50 上限、ask 三态、stub 指向、ATP × 3） |

### 3.3 新增 Phase B 验收脚本：`scripts/smoke-phase-b-acceptance.ts`

针对本次 4 项修复直接验证，**不依赖网络、不依赖 provider key**：

```
=== Phase B acceptance smoke ===

  PASS  B4: bash returns within 3s after ctx.abortSignal aborts
  PASS  B4: bash run() resolves (does not throw on abort)
  PASS  B2: tool.run received a ToolContext
  PASS  B2: ctx.sessionId starts with 'agt_'
  PASS  B2: ctx.cwd is process.cwd()
  PASS  B2: ctx.abortSignal is an AbortSignal
  PASS  B2: ctx.session.todoList is an array
  PASS  B2: ctx.isInteractive callable
  PASS  B2: ctx.config present
  PASS  B2: ctx.projectId is 12 hex chars
  PASS  B1: exactly one `tool.call` emitted per agent-loop bash call (no double count)

=== 11 passed, 0 failed ===
```

实现要点：
- `setTelemetrySink({...})` 注入内存 sink，捕获 agent loop 在工具执行前后发出的事件；运行 1 个 `bash` 工具调用后断言 `tool.call`（`tool === "bash"`）数量 = 1。
- `AbortController` 在 100 ms 后 abort，期望 bash 在 < 3 s 内返回（远低于 5 s 的 `Start-Sleep` / `sleep` 命令；如果 abort 没接通则等满 5 s 才超时）。
- 替换 `getProvider("openai").complete` 为 stub，模拟"第一轮 tool_use → 第二轮 stop"，期间 `bashTool.run` 被 monkey-patch 为只记录 `ctx`。

---

## 4. B1 屏障 / step-06–11 接口确认

- **`Tool` / `ToolContext` / `ToolResult` / `DescribeOptions` / `DescribedTool`**：未改字段、未改字段语义；step-11 引入的 `ToolContext.session` / `askUser` / `isInteractive` 仍是 *可选* 字段（追加规则）。
- **`AgentRole`**：单源 `src/types/agent.ts`；telemetry events 现在 `re-export type` 同一份；step-07 `ROLE_AFFINITY` / step-11 `userFacingName` 等消费方零改动。
- **`tool.call` telemetry 单源**：agent loop wrapper 是唯一发射点；工具内部如需更细的 ok/durMs，写入 `ToolResult.meta` / `structuredOutput`（step-22 / step-27 已经这么消费）。
- **`bash` 接口签名**：`run(args, ctx?)` 兼容旧两形态调用。`scripts/smoke-step09.ts` 仍只传 `args`，PASS 不变。

---

## 5. 与下游步骤的衔接点（更新）

| 下游 step | 衔接位置 | 怎么改 |
|---|---|---|
| **step-12**（permission engine） | `tool.checkPermissions` 自动成为 layer-1；`ctx.permissions` 占位 `{}` 替换为真引擎 | 本步未动 |
| **step-13**（hook engine） | `ctx.hooks` 占位 `{}` 替换为真引擎；agent loop 在 `tool.run` 前后发 `PreToolUse` / `PostToolUse` | 本步留好 hook 字段 |
| **step-14**（sandbox） | `bash.ts:sandboxStub` → `harness/sandbox/shellSandbox` | 本步未动 |
| **step-16**（QueryEngine） | 接管 `ToolContext` 构造（接 `costTracker` / 真 `permissions` / 真 `hooks` / sub-agent 隔离） | 本步搭好最小 ctx 模型，step-16 在此之上扩展即可 |
| **step-18**（sub-agent runtime） | `ctx.spawnSubAgent` 接通；`agent` 元工具的 stub 自动转为委托路径 | 本步无须改 |
| **step-19**（built-in agents） | 单源 `AgentRole`（已统一），`BuiltInAgentDefinition.role` 不会再撞 `events.ts` | 本步无须改 |
| **step-22**（agent UI） | `ctx.askUser` / `ctx.isInteractive` 接通；REPL 装上 `AskUserOverlay` | 本步搭好 hook 点 |
| **step-23**（task system） | `bash.ts:bgTasks` Map → 真任务表 | 本步无须改 |
| **step-27**（context monitor） | 消费 `tool.call` / `tools.described` —— 现在不再被双计数误导 | 本步把 telemetry 单源化 |
| **step-30**（e2e tests） | `scripts/smoke-phase-b-acceptance.ts` 11 条断言可直接迁移到 `bun:test` | — |

---

## 6. 后续提醒

1. step-16 接 `ToolContext` 时：扩展本步搭好的最小 ctx，加 `costTracker`、`memory`（step-25）、`hooks`（step-13）、`permissions`（step-12）。**不要重写 ctx 构造**——只追加字段。
2. step-22 落地 `AskUserOverlay` 时：在 REPL 路径调 `runAgent({ ..., askUser, isInteractive: () => process.stdin.isTTY })`。**不要硬编码 askUser 到 tool 文件里**。
3. step-18 落地 sub-agent 时：sub-agent 的 ctx **必须**携带独立 `AbortController`（AGENTS.md §9 红线），不能共用父 agent 的 `signal`。
4. step-12 接入时：删除 `bash.ts` / `file_edit.ts` / `file_write.ts` 的 "defense-in-depth" 二次校验注释，全权交给 6 层引擎；`evaluateDanger` 的 `deny` 仍保留为最后一道防线。
5. 任何新工具仍**禁止**在 `run()` 内 emit `tool.call`——agent loop 是唯一来源；细粒度信息走 `meta` / `structuredOutput`。
