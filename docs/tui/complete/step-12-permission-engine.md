# Step 12 完成报告 — Permission Engine（6 层决策 + 5 模式）

> 完成日期：2026-06-18
> 范围：`docs/step-12-permission-engine.md`、`src/harness/permissions/`、`src/agent/agent.ts` 接线、CLI 模式透传、`src/types/tool.ts` 注释更新
> 依赖：step-06（Tool 协议 / `ToolContext` / `PermissionPreflight` 已冻结）、step-09（bash AST / 命令分类复用）
> 结论：6 层决策引擎 + 5 种权限模式 + 拒绝熔断器全部落地；4 条验收标准 + L1/L4 顺序风险 + 规则匹配语法均通过 `scripts/smoke-step12.ts`（20/20）；Phase B 全量冒烟无回归（11/11）；`bun run typecheck` 通过。

---

## 1. 依据

- `docs/step-12-permission-engine.md`（6 层伪码、5 模式、L1g 硬约束、熔断器、规则文件）
- `docs/architecture.md` §3.3（`Permission` / `PermissionMode` 接口冻结时点 = step-12）
- `AGENTS.md` §5（硬规则红线：`.gitconfig` / `.bashrc` / `.ssh/*` / `.git/` / `.chovy/secrets/` / `--no-verify` / `git push --force`）+ §9（反模式）
- `docs/innovations.md` §10（不引入 GrowthBook / 小模型分类器 / Docker 沙箱）
- `源码解析.md` + cc-haha `permissions.ts` / `denialTracking.ts` / `permissionRuleParser.ts` / `shellRuleMatching.ts` / `filesystem.ts`（`checkPathSafetyForAutoEdit` bypass 免疫设计）—— **取分层思路与 46 行熔断器，不复刻 GrowthBook / YOLO 分类器 / MCP 规则**

---

## 2. 产物

```
src/harness/permissions/
├── modes.ts             # 5 模式（单源 re-export config）+ 语义 helpers
├── denialTracking.ts    # 46 行熔断器（maxConsecutive:3 / maxTotal:20）
├── rules.ts             # rules.json 解析 + 匹配（whole / prefix:* / wildcard）
├── safety.ts            # L1g bypass 免疫硬黑名单（路径 + 命令）
├── engine.ts            # hasPermission 6 层决策核心
└── index.ts             # barrel + 类型导出
```

接线改动（遵循 §17 "追加不替换"）：
- `src/agent/agent.ts`：`AgentOptions` 新增 `permissionMode?`；构造 `PermissionEngineState` 注入 `ctx.permissions.preflight`；每次 `tool.run` 前调 `hasPermission`，`deny`→返回 `Permission denied` 跳过执行、`ask`→未接 UI 时拒绝（step-22 落地后交给 `ctx.askUser`）。
- `src/cli/index.tsx` + `AgentRepl.tsx` + `repl.tsx`：已 resolve 的 `ctx.mode` 透传 `runAgent({...,permissionMode})`。
- `src/types/tool.ts`：`PermissionEngine` 注释从 "placeholder until step-12" 更新为指向真实实现；**字段名 / 接口不变**（冻结保持）。
- `scripts/smoke-step12.ts`：20 项纯函数 + 真实工具验收脚本。
- `scripts/smoke-phase-b-acceptance.ts`：B2 用例显式传 `permissionMode: "bypassPermissions"`（该用例验证 ToolContext 接线，非权限策略）。

---

## 3. 设计要点

### 3.1 单源 `PermissionMode`
`PermissionMode` 字面量联合**只在 `src/config/config.ts`** 声明（CLI flag / config / env 共用）；`modes.ts` 仅 `export type { PermissionMode } from "../../config/index.js"`，不在 harness 层重声明（遵循 §17 `AgentRole` 单源先例）。

### 3.2 不破坏冻结接口
`PermissionEngine` 接口（`preflight?(toolName, args)`）在 step-06 已冻结。本步实现真实引擎并绑定到 `ctx.permissions.preflight`（adapter 把 `PermissionDecision` 映射为 `PermissionPreflight`），**不改 `ToolContext` 字段名**，只追加 `PermissionEngineState` 实例状态。

### 3.3 6 层决策顺序（与 step-12 伪码一致，L3/L4 经实测调序）
```
L1a deny-rule(whole tool)          → DENY
L1b ask-rule(tool+content)         → 标记 ask（dontAsk 时 L3 转 deny）
L1c tool.checkPermissions preflight → deny→DENY；ask→标记；allow→标记 preflightAllow
L1g safety(probeArgs)              → unsafe deny→DENY（bypass 免疫）；ask(git push --force)→标记
L2  bypassPermissions              → ALLOW（L1g deny 已生效，.gitconfig 仍拒）
    allow-rule                      → ALLOW
L4  acceptEdits(fs mutate)         → ALLOW     ← 提前到 L3 之前
    auto: SAFE_TOOLS / isBashSafe   → ALLOW
L3  dontAsk && wantsAsk            → DENY（触发熔断器）
L4' auto 余量                       → ask
    plan: 非 readonly 工具          → DENY
L5  hooks.emit('PermissionRequest') → 桩（step-13 接管）
L6  ask → 非交互/dontAsk DENY；无 askUser DENY(INTERNAL step-22)；否则 ask
```

**L3/L4 调序说明**：原伪码 L3（dontAsk→deny）在 L4 之前，但 `acceptEdits` 的 fs-mutate 自动放行必须**先于** dontAsk 转换，否则非交互 `acceptEdits` 运行（sub-agent / `chat`）会把每次文件写都拒掉。实测发现此问题后把 `acceptEdits` / `auto` 安全工具的放行提到 L3 之前；**deny 规则（L1a）与 safety deny（L1g）仍在最前**，红线不受影响。这是 step-12 §风险"L1/L4 顺序错乱"的实测结论。

### 3.4 L1g bypass 免疫（AGENTS.md §5 代码化）
`checkPathSafety`：`.gitconfig` / `.bashrc` / `.zshrc` / `.profile` / `.npmrc` / `.netrc` / `.gitmodules` / `.ssh` / `.aws/credentials` / `.git/`（尾段）/ `.chovy/secrets/` → deny，**对所有模式生效**（bypass 也拒）。
`checkCommandSafety`：`--no-verify` → deny；`git push --force` / `-f` / `--force-with-lease` → ask（常用，不直接 deny）。

### 3.5 `auto` 模式无小模型
`SAFE_TOOLS` 白名单（echo / file_read / glob / grep / web_search / todo_write / skill）+ `bash` 经 `parseBashCommand` + `isAllReadOnly` 判定只读链 → allow；其余 → ask。**不**引入 GrowthBook / 小模型分类器（AGENTS.md §5 红线）。

### 3.6 拒绝熔断器
照搬 cc-haha 46 行：`maxConsecutive:3 / maxTotal:20`；任一达阈 → `auto` 降级 `default`（剩余会话，`autoDowngraded` 标记）。L3 与 L6 的拒绝都触发 `maybeTripBreaker`。

### 3.7 规则匹配（cc-haha `permissionRuleParser` + `shellRuleMatching` 精简）
- `Tool` → whole（全工具）
- `Tool(prefix:*)` → 前缀（content.startsWith）
- `Tool(*wild*)` → 通配（每次新建 RegExp，规避 §16 `g` 正则 lastIndex 陷阱）
- `\*` / `\\` 转义支持
- `~/.chovy/rules.json` + `<cwd>/.chovy/rules.json` 合并；ENOENT 静默跳过（safeFs 包装的 errno 从 `ChovyError.meta.errno` 提取）；坏 JSON / 坏行跳过 + warn，不抛

### 3.8 分层边界（harness→tools 边）
engine 只 reach `tools/exec/ast.js` + `tools/exec/classification.js` 两个**零外部依赖的纯函数叶子模块**（经核实 ast.ts 无 import、classification.ts 仅 type import），不引入 tool registry，无循环。

---

## 4. 验收标准对齐（`docs/step-12 §验收标准`）

| # | 标准 | 实测 | 脚本用例 |
|---|---|---|---|
| 1 | 默认模式 Read/Grep/Glob 直接通过；Edit 触发 ask；`rm -rf` 直接 deny | ✓ file_read/grep/glob allow；file_edit deny（无前置 read）/ask；`rm -rf /` deny（bash preflight L1c） | smoke-step12 [1] |
| 2 | plan 模式下任何 mutate 工具拒绝 | ✓ file_write / file_edit / bash 全 deny；file_read 仍 allow | smoke-step12 [2] |
| 3 | `bypassPermissions` 模式下 `.gitconfig` 修改仍被拒 | ✓ `~/.gitconfig` write deny；普通 write allow；`git --no-verify` deny | smoke-step12 [3] |
| 4 | 连续 3 次 ask 拒绝后 auto 降级 default | ✓ 3 次 file_write deny 后 `autoDowngraded=true`；纯成功不降级 | smoke-step12 [4] |
| 风险 | L1/L4 顺序：plan + acceptEdits 不串 | ✓ acceptEdits 放行 file_write、plan 拒绝；deny 规则压过 acceptEdits | smoke-step12 [5] |
| 语法 | `Tool(prefix:*)` 前缀匹配 | ✓ `bash(npm test:*)` 放行 `npm test --foo`、不放行 `npm install`；`bash(rm -rf:*)` deny | smoke-step12 [6] |

---

## 5. 实测验收

### 5.1 类型检查
```
$ bun run typecheck
$ tsc --noEmit
(no output, EXIT=0)
```

### 5.2 step-12 验收脚本
```
$ bun run scripts/smoke-step12.ts
[1] default mode        5/5 ✓
[2] plan mode           4/4 ✓
[3] bypass + .gitconfig 3/3 ✓
[4] auto → default      2/2 ✓
[5] L1/L4 ordering      3/3 ✓
[6] rule matching       3/3 ✓
20 passed, 0 failed
```

### 5.3 回归（Phase B 全量 + 工具冒烟）
| 脚本 | 结果 |
|---|---|
| `smoke-phase-b-acceptance.ts` | 11/11 ✓（B2 用例显式 bypass 以隔离权限策略） |
| `smoke-step07.ts` | ✓ |
| `smoke-step09.ts` | ✓ |
| `smoke-step10.ts` | 14/14 ✓ |
| `smoke-step11.ts` | 45/45 ✓ |
| `smoke-fs-tools.ts` | ✓ |

---

## 6. 接口冻结确认（architecture.md §3.3）

| 接口 | 冻结时点 | 本步状态 |
|---|---|---|
| `Permission` / `PermissionMode` | 12 | ✓ `PermissionMode` 单源 config；`PermissionEngine` 接口未改字段名；`PermissionDecision` / `PermissionEngineState` 为本步新增 |
| `Tool` / `ToolContext` | 06 | ✓ 未改字段名；`ctx.permissions` 从占位 `{}` 升级为真实 engine（接口兼容） |
| `HookEvent` / `HookHandler` | 13 | — L5 仅留 `ctx.hooks.emit('PermissionRequest')` 调用点，step-13 接管 |

---

## 7. 为下游留的接口

- **step-13（hook 引擎）**：`engine.ts` L5 已有 `ctx.hooks.emit('PermissionRequest', {tool, args})` 调用点 + `// TODO step-13: read the hook verdict`。step-13 把 `HookEngine` 接通后，`emit` 返回 `{allow|deny|undefined}` 即可短路。
- **step-14（沙箱）**：`safety.ts` 是 bypass 免疫层；沙箱在 engine **之下**分层（沙箱放行的命令仍受 rules / mode / safety 约束）。bash 工具已有 `sandboxStub`。
- **step-22（AskUserOverlay）**：L6 的 `ctx.askUser` 分支已就绪；step-22 落地后 `ask` 结果交给 `ctx.askUser`，denied→`recordDenial`、approved→`recordSuccess`。
- **step-18（子 agent）**：`createPermissionEngineState` 接受独立 `mode` / `dontAsk` / `rules`；子 agent 构造自己的 `PermissionEngineState`（独立熔断器，独立 AbortController，AGENTS.md §9）。
- **`auto.classifier` feature**：本步未启用；`feature('auto.classifier')` 留桩，开启后可在 L4 auto 分支接入小模型分类（非默认）。

---

## 8. 风险与已知限制

- **非交互 `default` 模式下 bash 普通命令被拒**：`echo hi` 的 bash preflight 返回 `ask`（step-09 §7 "defer to engine"），`chat "..."` 非 TTY → ask→deny。这是安全默认的正确行为；用户需 `--permission-mode acceptEdits`/`bypassPermissions` 或写 allow 规则。Phase-B B2 用例已显式 bypass 隔离。
- **`bypassPermissions` 仍非"任意放行"**：L1g 安全 deny 对所有模式免疫——这是 AGENTS.md §5 红线的硬约束，非 bug。
- **规则匹配基于 argv/命令文本**：heredoc / 子壳内的危险模式由 bash 工具自身的 `evaluateDanger`（step-09）+ safety 双层覆盖；不保证 100% 拦截（fail-safe：未识别 → ask）。
- **`plan` 模式对 bash 一律拒**：即使 `ls`（只读）。符合 step-12 "任何 mutate/exec 直拒"——bash 属 exec 族。读文件请用 `file_read` / `glob` / `grep`。

---

## 9. AGENTS.md §5 合规

- 未修改 `~/.gitconfig` / dotfiles / `.git/` / `.chovy/secrets/`（本步反而是把它们**保护**进代码）；
- 未在 git 命令加 `--no-verify`（代码里 `--no-verify` → deny）；
- 未 force push / `rm -rf`；
- 未引入新依赖（仅复用 `node:os` / `node:path` + 现有 `safeFs` / `logger` / step-09 AST）；
- 未修改 `bin/chovy.js` / `bin/chovy.js.map`；
- 未引入 GrowthBook / 小模型 / Docker（§5 红线 + innovations §10）；
- 未复刻 cc-haha 全部权限代码（取分层 + 熔断器 + bypass 免疫，丢 YOLO/MCP/policy）。
