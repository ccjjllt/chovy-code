# Step 13 完成报告 — Hook Engine（12 类事件 + 竞速机制）

> 完成日期：2026-06-18
> 范围：`docs/step-13-hook-engine.md`、`src/harness/hooks/`、`src/types/hook.ts` 类型冻结、`src/agent/agent.ts` 接线、`src/harness/permissions/engine.ts` L5 接管、`src/telemetry/events.ts` 新增 `hook.run`、`src/types/tool.ts` HookEngine 注释更新
> 依赖：step-06（`ToolContext.hooks: HookEngine` 冻结接口）、step-12（权限引擎 L5 调用点 + 6 层决策顺序）
> 结论：12 事件 + 竞速 + 启动快照 + Trust 边界全部落地；4 条验收标准 + 竞速语义 + 快照防热改 + Trust 门控均通过 `scripts/smoke-step13.ts`（38/38）；Phase B 全量冒烟无回归（step-09/10/11/12 + phase-b 共 90+ 项全绿）；`bun run typecheck` 通过。

---

## 1. 依据

- `docs/step-13-hook-engine.md`（12 事件清单 + 竞速伪码 + 启动快照 + Trust 边界 + 返回值规约）
- `docs/architecture.md §3.3`（`HookEvent` / `HookHandler` 接口冻结时点 = step-13）
- `AGENTS.md §17`（追加不替换 / `tool.call` 单源 telemetry 不变量）、§18（L5 调序不变、`PermissionEngine` 字段名不变、harness→tools 边只 reach 零依赖叶子）、§5（硬规则红线）、§16（`g` 正则 lastIndex 陷阱）
- `源码解析.md` 第七章 + cc-haha `utils/hooks.ts`（5040 行）/ `hooksConfigSnapshot.ts` / `hooksSettings.ts` —— **取分层思路 + 46 行 snapshot + 信任边界 + 返回值规约；不复刻 5040 行全量 / GrowthBook / 多 source 层级 / plugin hook registry / MCP elicitation / callback-guard 竞速**

---

## 2. 产物

```
src/harness/hooks/
├── trust.ts          # ~/.chovy/trust.json 读写 + shouldAllowManagedHooksOnly + 父目录继承
├── settings.ts       # settings.json zod 校验 + 加载 + 通配匹配器（* / Tool / Tool(*wild*)）
├── snapshot.ts       # 启动快照（in-memory 冻结 HookConfig[]，防热改注入）
├── runners.ts        # command runner（spawn + 跨平台 killTree + 超时） / function runner（dynamic import ESM）
├── engine.ts         # createHookEngine + emit（advisory）+ runPermissionRequest（decisive 竞速）
└── index.ts          # barrel + 类型导出
```

类型冻结（`src/types/hook.ts` 重写，原 DRAFT 仅 barrel re-export 无消费者）：
- `HookEvent`（12 事件单源字面量联合）
- `HookOutcome`（allow / block / bypass）、`HookResult`（`{ok:true}` / `{ok:false,reason}` / undefined）
- `HookPermissionDecision`（`{behavior:"allow"}` / `{behavior:"deny",reason}` / undefined）
- `HookContext`、`HookPayload`、`HookConfig`
- `HookEngine` 接口（`emit?` + `runPermissionRequest?`）

接线改动（遵循 §17/§18 "追加不替换"）：
- `src/types/tool.ts`：`HookEngine` 从 `export interface`（占位）改为 `import type { HookEngine } from "./hook.js"`（**不 re-export**，避免 barrel 双导出冲突）；`ToolContext.hooks: HookEngine` 字段名不变。注释从 "placeholder until step-13" 更新为指向真实实现。
- `src/agent/agent.ts`：`AgentOptions` 新增 `hooksSettingsPaths?` + `onHookMessage?`；构造 `createHookEngine` 注入 `ctx.hooks`（替换 `{}`）；agent loop 发射 `SessionStart` / `PreToolUse`（block 短路）/ `PostToolUse` / `PostToolUseFailure` / `PermissionDenied` / `SessionEnd`。
- `src/harness/permissions/engine.ts` L5：`ctx.hooks.emit('PermissionRequest')` 桩替换为 `ctx.hooks.runPermissionRequest(...)`；decisive `allow`→短路 allow、`deny`→短路 deny + 触发熔断器；`undefined`（旁路）落 L6。**L1/L4 调序不变**（§18）。
- `src/telemetry/events.ts`：新增 `hook.run` 事件（`{ type, event, hookName, outcome, durMs, ts }`）；**单源发射点在 engine**（runners 禁止 emit，同 §17 `tool.call` 不变量）。
- `scripts/smoke-step13.ts`：38 项纯函数 + 真实 spawn + 真实权限引擎验收脚本。

---

## 3. 设计要点

### 3.1 `HookEvent` 单源 = `src/types/hook.ts`
12 事件字面量联合**只在 `types/hook.ts`** 声明；`harness/hooks/` 通过 re-export 复用，不在 harness 层重声明（遵循 §17 `AgentRole` / §18 `PermissionMode` 单源先例）。8 个镜像 cc-haha 事件面 + 3 个 chovy 新增（`GoalIteration` / `SubAgentSpawn` / `CheckpointWritten`）+ `PostToolUseFailure`。

### 3.2 不破坏冻结接口（§18）
`ToolContext.hooks: HookEngine`（step-06 冻结）的 `emit?(event, payload): Promise<void>` 字段名**保持**。step-13 追加可选 `runPermissionRequest?()` handle（追加可选字段 permitted，rename 不 permitted）。`tool.ts` 用 `import type`（不 re-export）避免 barrel 双导出冲突。

### 3.3 竞速机制按 spec 落地（spec §竞速字面 `Promise.race`）
spec 明确写 `Promise.race([userPrompt(), hook.run('PermissionRequest'), classifier?.run()])`。chovy-code 当前 `ctx.askUser`（step-22 未落地）+ 无 classifier（§5 红线），所以竞速退化为：**hook 若返回 decisive allow/deny → 胜出；否则旁路落 L6**。`runPermissionRequest` 返回首个 decisive 裁决或 `undefined`。step-22 落地后 agent loop 用 `Promise.race([ctx.askUser, runPermissionRequest])` 接入用户对话框——本步的返回值形状（decisive vs undefined）已为此留好。

### 3.4 `{ok:true}` 不视为 decisive（spec 明确）
只有 `{ok:false}`（deny）或 PermissionRequest 专用 `hookSpecificOutput.permissionDecision:"allow"` 才决策成功。`{ok:true}` / 无 stdout / 超时 / 非零退出 → 旁路（undefined / bypass）。`parsePermissionDecision` 明确：`{ok:true}` 返回 `null`（不 decisive）。

### 3.5 启动快照防热改（spec §启动快照）
`snapshot.ts`：`createHookEngine` 构造时 `captureSnapshot()` 读盘一次 → 冻结 in-memory `HookConfig[]`；本会话所有 `emit` / `runPermissionRequest` 读快照副本，**不重读盘**。避免对话中改 settings.json 立即生效的安全隐患（cc-haha `hooksConfigSnapshot` 思路）。

### 3.6 Trust 边界（spec §Trust 边界）
`~/.chovy/trust.json`（`{ "<normalizedCwd>": true }`），`shouldAllowManagedHooksOnly(cwd)` 读它 + 父目录继承（信任 `~/dev` → 信任 `~/dev/chovy-code`）。未信任 cwd：只允许 `managed:true` 钩子（chovy 内置），拒绝用户写的 command/function 钩子。ENOENT 静默 → 未信任。Trust dialog UI 留给 step-22；本步只实现 trust.json 读写 + 纯函数。

### 3.7 超时 + 跨平台 killTree
默认 `timeoutMs=2000`（spec §风险），硬上限 `10_000`。超时 → killTree + 旁路 + telemetry `outcome:"timeout"`。Windows 上 `child.kill("SIGTERM")` 只杀 shell（powershell）不杀工作进程（node），导致 stdio 管道不关、`close` 事件不触发、超时"失效"。`killTree` 在 Windows 用 `taskkill /T /F /PID` 杀整树，POSIX 用 `process.kill(-pid, SIGTERM)`（需 `detached:true` spawn）。

### 3.8 返回值规约（spec §返回值规约）
- `{ok:true}` → advisory pass（不 decisive）
- `{ok:false,reason}` → block（PreToolUse）/ decisive deny（PermissionRequest）
- 无 stdout / 超时 / 非零退出 → 旁路（无意见）
- 退出码 0 必需；非 0 → 旁路 + telemetry warn

### 3.9 分层边界（harness→tools 边，§18 同例）
hook 层是**叶子**：只 reach `node:child_process` / `node:path` / `node:os` + 现有 `safeFs` / `logger` / `zod` / `telemetry`。**不**引入 tool registry、**不** reach `tools/exec/bash.ts`（shell 选择 + killTree 独立实现，避免循环）。matcher 通配语法是 `rules.ts` `matchWildcardPattern` 的**精简端口**（不 import，避免拉权限引擎 rule 类型进 hook 层）。

### 3.10 telemetry 单源
`hook.run` 事件**只在 `engine.ts` 发射**（`emitHookTelemetry`）；runners 禁止 emit（同 §17 `tool.call` 不变量）。`outcome` 5 态：`ok` / `blocked` / `bypassed` / `error` / `timeout`。

---

## 4. 验收标准对齐（`docs/step-13 §验收标准`）

| # | 标准 | 实测 | 脚本用例 |
|---|---|---|---|
| 1 | PreToolUse 钩子 stderr 输出会出现在 UI | ✓ engine 捕获 runner stderr → logger.info；agent loop `onHookMessage` 回调（block 时触发） | smoke-step13 [1] |
| 2 | PermissionRequest 钩子 0.1s 返回 deny → 用户对话框被取消 | ✓ L5 `runPermissionRequest` decisive deny 短路 L6；deny reason 透传 hook reason | smoke-step13 [2] |
| 3 | PostToolUse 钩子失败 ≠ 工具失败（记 telemetry） | ✓ hook 非零退出 → `outcome:"bypassed"` + telemetry；tool.call ok 不受影响 | smoke-step13 [3] |
| 4 | 未信任工作区拒绝执行用户写的钩子 | ✓ `trusted:false` → 用户钩子 bypassed + managed 钩子仍跑；`trusted:true` → 用户钩子跑 | smoke-step13 [4] |
| 竞速 | `{ok:true}` 不 decisive | ✓ parsePermissionDecision `{ok:true}` → null；engine 返回 undefined | smoke-step13 [6] |
| 竞速 | PermissionRequest allow 短路 | ✓ `hookSpecificOutput.permissionDecision:"allow"` → permission allow | smoke-step13 [5] |
| 快照 | 改 settings 后本会话仍用旧快照 | ✓ engine 构造时冻结 snapshot，后续 emit 读副本 | smoke-step13 [8] |
| 超时 | 超时 → 旁路 + 近上限 | ✓ 200ms 超时 → bypass，durMs < 2000 | smoke-step13 [7] |

---

## 5. 实测验收

### 5.1 类型检查
```
$ bun run typecheck
$ tsc --noEmit
(no output, EXIT=0)
```

### 5.2 step-13 验收脚本
```
$ bun run scripts/smoke-step13.ts
[1] PreToolUse stderr surfaces to onHookMessage     1/1 ✓
[2] PermissionRequest deny short-circuits           2/2 ✓
[3] PostToolUse failure ≠ tool failure              1/1 ✓
[4] Untrusted workspace: user hooks refused         3/3 ✓
[5] PermissionRequest allow short-circuits allow    1/1 ✓
[6] {ok:true} not decisive for PermissionRequest    1/1 ✓
[7] Hook timeout → bypass                           2/2 ✓
[8] Snapshot freezes at construction                2/2 ✓
[9] pure helpers                                   18/18 ✓
[10] trust helpers                                  5/5 ✓
38 passed, 0 failed
```

### 5.3 回归（Phase B 全量 + 工具冒烟）
| 脚本 | 结果 |
|---|---|
| `smoke-step12.ts` | 20/20 ✓（L5 改动无回归） |
| `smoke-step11.ts` | 45/45 ✓ |
| `smoke-step10.ts` | 14/14 ✓ |
| `smoke-step09.ts` | ✓ |
| `smoke-phase-b-acceptance.ts` | 11/11 ✓ |

---

## 6. 接口冻结确认（architecture.md §3.3）

| 接口 | 冻结时点 | 本步状态 |
|---|---|---|
| `HookEvent` / `HookHandler` | 13 | ✓ `HookEvent` 12 事件单源 `types/hook.ts`；`HookEngine` 接口 `emit?` 字段名不变 + 追加 `runPermissionRequest?` |
| `Tool` / `ToolContext` | 06 | ✓ 未改字段名；`ctx.hooks` 从占位 `{}` 升级为真实 engine（接口兼容） |
| `Permission` / `PermissionMode` | 12 | ✓ L5 调用点从桩升级为真实 `runPermissionRequest`；L1/L4 调序不变（§18） |

---

## 7. 为下游留的接口

- **step-22（AskUserOverlay）**：`runPermissionRequest` 返回 decisive / undefined 形状已就绪；step-22 落地后 agent loop 用 `Promise.race([ctx.askUser, runPermissionRequest])` 接入用户对话框，hook 先返回 decisive 即取消对话框。Trust dialog 也由 step-22 调 `markTrusted(cwd)`。
- **step-14（沙箱）**：hook runner 的 spawn 在 engine 之上分层；沙箱放行的命令仍受 trust / settings / 超时约束。
- **step-18（子 agent）**：`createHookEngine` 接受独立 `cwd` / `sessionId` / `settingsPaths` / `snapshot` / `trusted`；子 agent 构造自己的 engine（独立快照 + 独立 AbortController，AGENTS.md §9）。
- **step-23（goal loop）**：`GoalIteration` 事件已冻结；goal loop 每轮迭代 `ctx.hooks.emit('GoalIteration', {round, converged})`。spec 示例 `{"event":"GoalIteration","matcher":"*","command":"bun typecheck"}` 即可用。
- **step-26（checkpoint）**：`CheckpointWritten` 事件已冻结；checkpoint writer 落盘后 emit。
- **`onHookMessage` 回调**：`AgentOptions.onHookMessage?` 已就绪；step-22 Ink UI 安装后 PreToolUse block reason / hook stderr 渲染到面板。

---

## 8. 风险与已知限制

- **Windows killTree 用 `taskkill /T /F`**：若系统无 `taskkill`（极罕见）退化为 `child.kill`，超时可能"失效"（孤儿进程持有 stdio）。POSIX 用进程组信号，可靠。
- **function hook 超时无法强取消**：JS Promise 不可取消；超时仅让 race 胜出，函数可能后台继续跑。command hook 无此问题（killTree 强杀）。
- **竞速当前单车道**：step-22 落地前无用户对话框可竞速，`runPermissionRequest` 实际是"hook 先 decisive 即胜，否则旁路"。spec 的 `Promise.race` 形状在返回值层面已就绪，step-22 接入即完整。
- **`emit` 返回 `HookOutcome` 而非 `void`**：step-06 冻结签名是 `emit?(event, payload): Promise<void>`；本步实现返回 `Promise<HookOutcome>`（agent loop 读 outcome 做 PreToolUse block 短路）。`Promise<HookOutcome>` 是 `Promise<void>` 的超集（调用方忽略返回值即兼容），未破坏冻结签名。
- **trust.json 无加密**：明文 JSON，记录 cwd → trusted。与 cc-haha 的 `config.projects[<path>].hasTrustDialogAccepted` 同级别保护（用户主目录文件权限）。
- **matcher 语法是 rules.ts 的精简子集**：不支持 `Tool(prefix:*)` legacy 前缀语法（hooks 用 `Tool(*prefix*)` 通配代替）；`*` / `Tool` / `Tool(*wild*)` 三种够用。

---

## 9. AGENTS.md §5 合规

- 未修改 `~/.gitconfig` / dotfiles / `.git/` / `.chovy/secrets/`（trust.json 是新建 `~/.chovy/trust.json`，非修改受保护文件）；
- 未在 git 命令加 `--no-verify`（代码里 `--no-verify` → deny 在 step-12 safety 层，本步不碰）；
- 未 force push / `rm -rf`；
- 未引入新依赖（仅复用 `node:child_process` / `node:path` / `node:os` + 现有 `safeFs` / `logger` / `zod` / `telemetry`）；
- 未修改 `bin/chovy.js` / `bin/chovy.js.map`；
- 未引入 GrowthBook / 小模型 / Docker（§5 红线 + innovations §10）；
- 未复刻 cc-haha 5040 行全量（取分层 + 快照 + 信任边界 + 返回值规约，丢 multi-source / plugin registry / MCP elicitation / callback-guard 竞速 / GrowthBook）。
