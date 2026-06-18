# AGENTS.md

> 这是面向 **编码型 AI 智能体（agents）** 的仓库级指南——给任何在 `chovy-code` 仓库中工作的
> agent（无论是 chovy 自己、Claude Code、Codex、Cursor，或人类协作者）使用。
> 它告诉你：仓库目前在哪里、要去哪里、必须遵守的规则、推荐的工作流、以及如何避免踩坑。
>
> 如果本文与 `docs/` 中的任何具体步骤文档冲突，**以 `docs/` 中的步骤文档为准**——本文是导航，不是规约。

---

## 1. 项目一句话

`chovy-code` 是一个用 **Bun + TypeScript + React/Ink** 构建的多 provider 编码代理 CLI，
对标 Claude Code / cc-haha，但在 5 处做了差异化创新（ATP / SwarmR / TMT / SCW / CSG，详见 `docs/innovations.md`）。

当前阶段：**Phase A（step-01–05）与 B1（step-06–07：Tool Protocol v2 + ATP allocator）已完成构建并完成验收追补**。
下一步主线是继续 Phase B 的真实工具与 Harness 接线：step-08–11（仓库中已有 step-08 fs tools 产物与报告，继续依赖方前应按其文档单独验收）以及 step-12 权限引擎。

---

## 2. 在动手之前必须读的 4 份文档

按顺序：

1. **`docs/README.md`** — 30 步路线图、9 阶段、5-worker 并行计划。先看这里定位你要做的步骤。
2. **`docs/architecture.md`** — 目标目录树、模块依赖图、屏障同步点（B1–B4）、接口冻结时点。
3. **`docs/innovations.md`** — 5 项核心创新的设计与差异化点；不要自己重新发明 ATP/SwarmR 等。
4. **`docs/step-XX-*.md`** — 你要做的那一步的详细实现要点、接口签名、验收标准。

> 不读 `docs/` 直接动手编码会大概率跑偏——本仓库**先有计划，再有代码**。

---

## 3. 仓库现状（截至本文）

```
chovy-code/
├── bin/chovy.js              # 已构建 CLI 入口（自动产物）
├── docs/                     # 计划文档 + complete/ 完成/验收报告
├── package.json              # Bun + React 18 + Ink 5 + Zod 3 + Commander 12
├── scripts/build.ts          # bun.build 打包脚本
├── 源码解析.md                # cc-haha 源码解读（参考资料，非本仓库代码）
└── src/
    ├── index.ts              # public barrel
    ├── version.ts
    ├── agent/agent.ts        # 最小 agent loop（completion → tool → repeat）
    ├── cli/index.tsx         # commander 入口（subcommands + REPL 路由）
    ├── cli/repl.tsx          # step-05 交互式 REPL 主屏
    ├── cli/components/       # AgentRepl / StatusLine / HeaderBar / MessageList
    ├── config/               # zod 配置合并 + secrets + features
    ├── fs/                   # chovy home / project paths / safeFs
    ├── logger/               # 结构化 logger
    ├── telemetry/            # 本地 JSONL telemetry sink
    ├── providers/            # registry + openai 参考实现 + 6 个 scaffold
    ├── tools/                # Tool v2 registry + ATP allocator + echo + fs / exec / web / meta 工具
    ├── harness/              # 缰绳层：permissions（6 层引擎 + 5 模式 + 熔断器）
    └── types/                # provider / messages / tool 契约
```

**已具备**：Bun + Ink 工具链、Provider/Tool 注册中心、最小 agent loop（构造最小 `ToolContext` 并下发到 `tool.run`）与流式 UI 渲染；
step-01–05 的类型/错误、配置/secrets/features、结构化日志、本地 telemetry、safeFs、CLI 子命令和 REPL 骨架；
step-06–07 的 Tool Protocol v2、lean/full 描述、工具注册元数据、ATP 预算分配器、`tools.described` telemetry；
step-08 fs 工具（read/write/edit/glob/grep）；step-09 bash（AST + 双窗截断 + 单槽 hint + 跨平台 spawn + ctx.abortSignal 接通）；
step-10 web（fetch + search + 自研 htmlToMd + 私网拒绝 + 跨域重定向不跟随 + 15min LRU）；
step-11 meta（todoWrite / askUserQuestion + skill/agent stub）。Phase B 验收报告见 `docs/complete/step-06-11-phase-b-acceptance.md`。
step-12 权限引擎（6 层决策 + 5 模式 + 拒绝熔断器 + L1g bypass 免疫安全检查 + rules.json 加载/匹配），agent loop 每次 `tool.run` 前过 `hasPermission` 网关。完成报告见 `docs/complete/step-12-permission-engine.md`。
**未实现**：沙箱（step-14）、hook 引擎（step-13）、QueryEngine（step-16）、子智能体真实运行（step-18/20）、记忆/checkpoint（step-24–28）、目标循环（step-23）、技能图（step-29）、所有非 openai provider 的真实网络接线（step-17）。

---

## 4. 你（agent）会被以哪些角色调用

`chovy-code` 自身设计了多种 agent 角色（详见 `docs/step-19-built-in-agents.md`）。
当你以某一角色被调用时，请遵守相应约束：

| 角色 | 工具白名单 | 模型偏好 | omitMemory | 行为约束 |
|---|---|---|---|---|
| `main` | 全部 | 用户指定 | false | 主驾，统筹工具与子 agent |
| `explore` | read/glob/grep/ls | 小模型 | true | **严格只读**；禁止 edit/write/bash mutate |
| `plan` | read/glob/grep | 长上下文模型 | false | 不写代码；输出 Plan 模板（Goal/Approach/Steps/Critical Files/Risks） |
| `verify` | bash/read/grep/glob | 继承父 | false | 输出 PASS / FAIL / PARTIAL；独立验证不被偏见 |
| `critic` | read/grep/web | 与父异构 | false | 必须找出风险；不允许 "looks good" |
| `checkpoint-writer` | read/write(checkpoints/) | 小模型 | true | 严格按 step-26 模板输出，不超 8KB |

如果你不清楚自己的角色，看 system prompt 中的 `<agent-role>` 标记，或默认按 `main` 行事。

---

## 5. 必须遵守的硬规则

> 这些规则**对所有 agent / 所有权限模式（包括 bypassPermissions）生效**。违反它们的 PR 一律拒绝合并。

1. **不修改 `~/.gitconfig`、`.bashrc`、`.zshrc`、`.profile`、`~/.ssh/*`、`~/.aws/credentials`、`.npmrc`、`.netrc`**。
2. **不修改项目内 `.git/`、`.chovy/secrets/`、`.vscode/`、`.idea/`**。
3. **不在 git 命令上加 `--no-verify`**，除非用户明确要求（写明哪一句）。
4. **不 `git push --force` / `--force-with-lease`**，除非用户明确要求。
5. **不 `rm -rf`** 任何超出当前 cwd 的路径；项目内也要二次确认。
6. **不上传任何代码 / secrets / 日志到外部服务**，包括 pastebin、issue tracker、文档站等。
7. **不引入 GrowthBook、Anthropic prompt cache 价格优化逻辑、Docker/VM 沙箱、TEAMMEM 团队记忆**——这些已被 `innovations.md §10` 明确排除。
8. **不复刻 `cc-haha` 的全部代码**——chovy-code 是差异化产品，不是 cc-haha 镜像。借鉴归借鉴，主线必须按 5 项创新走。

如果用户的指令与以上冲突，**先反馈风险，等待显式确认**。

---

## 6. 推荐工具优先级（与 chovy-code 自身的 system prompt 一致）

无论你用哪个外部 IDE 工作：

- 读文件 → **Read**（不要 cat/head/tail/sed）
- 编辑文件 → **Edit**（不要 sed/awk）
- 文件名匹配 → **Glob**（不要 find/ls）
- 内容搜索 → **Grep / ripgrep**（不要 grep + find 拼装）
- 网络抓取 → **WebFetch**（不要 curl 抓 HTML 自己解析）
- 运行测试 / 命令 → **Bash**，但用绝对路径，避免 `cd` 副作用

工具调用要**先思考最简方案**，能一步到位别绕路；能并行（独立调用）一起发，不要串行。

---

## 7. 工作流（按你要做什么对号入座）

### 7.1 我要写代码实现一个 step

1. 找到你的 step 文件，例如 `docs/step-08-fs-tools.md`；
2. 检查它的依赖步骤是否已完成（B1–B4 屏障）；
3. 严格按"产物"清单创建/修改文件，**不**临时增删模块；
4. 接口签名以 step 文档为准——后续步骤会按这些签名接线，私改会破坏并行；
5. 保留 `// TODO step-XX` 标记，方便后续步骤接管；
6. 自检通过：`bun run typecheck` 必须无错；
7. 运行 step 文档"验收标准"中的冒烟命令。

### 7.2 我要修一个 bug

1. 先 `Grep` 错误信息定位；
2. 用 `Read` 看上下文；
3. 用 `Edit` 做最小修复——**不**顺便重构（参考 §5、§9）；
4. 跑 `bun run typecheck`；
5. 如果 bug 与某个 step 的"风险"列有关，把修复结论补回该 step 文档的"风险"段。

### 7.3 我要改架构 / 加新模块

1. 先去 `docs/architecture.md` 与 `docs/innovations.md` 看是否已规划；
2. 如果是新需求，**先写 step 文档**（沿用 step-XX 模板）再写代码；
3. 改动 `docs/README.md` §3 的索引表；
4. 确认不破坏屏障同步点的接口冻结。

### 7.4 我要新增一个 provider

1. 看 `docs/step-17-providers-real.md`；
2. 在 `src/providers/capabilities.ts` 增加 `CAPS[<id>]`；
3. 实现 `Provider` 接口（仿 `openai.ts`）；
4. 在 `src/providers/index.ts` 注册；
5. 通过冒烟："echo via tool"。

### 7.5 我要新增一个工具

1. 看 `docs/step-06-tool-protocol-v2.md`；
2. 工具必须实现 **ATP 双描述**（lean / full）+ `family`；
3. 工具必须实现 `checkPermissions`（哪怕只是返回 `allow`）；
4. 在 `src/tools/index.ts` 注册；
5. 填好 `fullTriggers`，让 step-07 ATP 分配器能按预算把相关工具升到 full；
6. 别忘了在文档中找一个合适的命名空间（fs / exec / web / meta）。

### 7.6 我要新增一个子 agent 角色

1. 看 `docs/step-19-built-in-agents.md`；
2. 复用 `BuiltInAgentDefinition` 接口；
3. 列出它的 `disallowedTools` / `allowedTools`、模型偏好、`omitMemory`、system prompt；
4. 用最少必要权限（"least privilege" 原则）。

### 7.7 我要做长程任务（自己跑 /goal）

1. 必须有明确的 *收敛判据*（rubric 或 command）；
2. 默认 maxRounds=25、budget=$5——别盲目调高；
3. 反复修改而不进展时，主动停下问用户，**不要假装在工作**；
4. 每 5 轮主动触发一次 checkpoint（不要等到 soft 阈值）。

---

## 8. 编码风格与目录约定

- TypeScript：`strict: true`；目标 ESM；导入用 `.js` 后缀（Bun + ts→esm 兼容）。
- 不用 default export；命名导出更易 grep。
- 文件名：lowerCamelCase 或 kebab-case 都接受，**单一文件内统一**。
- 目录已在 `docs/architecture.md §1` 定义；新文件请放到对应模块，不要平铺到 `src/` 顶层。
- 单文件 ≤ 600 行；超出请拆 helper。
- 不要悄悄加新依赖；要加的话在 PR 描述里说明理由。
- 注释只写"为什么"，"是什么"靠类型与命名表达；保持语调简洁。

---

## 9. 不要做的事（给 agent 的反模式清单）

- ❌ 没读 `docs/` 就动手实现一个 step。
- ❌ 顺手"清理 / 重构 / 优化"未要求修改的代码。
- ❌ 把 5 项创新中的某一项静默替换成 cc-haha 的对应实现。
- ❌ 在工具描述里写超长 prompt（应该按 ATP 协议拆 lean/full）。
- ❌ 让子 agent 共享父 agent 的 AbortController（每个子 agent 独立信号）。
- ❌ 直接读 / 写应用文件不走 `safeFs` / `safeFsSync`（步骤 04 后接入）。
  例外：`src/telemetry/localSink.ts` 的 `beforeExit/exit` 同步 flush 可直接使用 sync fs，必须保持本地写入且不得上传。
- ❌ 在 system prompt 里硬编码 model 或 provider 名（用 capability 矩阵）。
- ❌ `console.log` 调试信息留在 PR 里。
- ❌ 修改 `bin/chovy.js` 与 `bin/chovy.js.map`——它们是构建产物，不是源码。
- ❌ 假装某个未实现的功能"已经接入"——返回明确的 `errorCode: 'INTERNAL'` + 提示步骤号。

---

## 10. 提交与 PR 约定

- 分支：`step-XX-<slug>` 或 `fix/<area>` 或 `docs/<topic>`。
- 提交信息：conventional commits（feat / fix / docs / refactor / chore / test）。
- PR 模板（建议）：
  ```
  ## 关联
  - step: docs/step-XX-...md
  - innovations: ATP / SwarmR / ...

  ## 改了什么
  - ...

  ## 验收
  - [ ] bun run typecheck 通过
  - [ ] 该步 docs 的"验收标准"全部通过
  - [ ] 不破坏屏障接口（见 architecture.md §3.3）

  ## 风险
  - ...
  ```

---

## 11. 命令速查（开发用）

```bash
bun install                      # 安装依赖
bun run dev                      # 监听模式跑 CLI
bun run start "explain this repo"# 一次性跑
bun run build                    # 构建到 bin/chovy.js
bun run typecheck                # tsc --noEmit
bun bin/chovy.js --version       # 跑构建产物
```

CLI（按 step-05 完成后）：

```bash
chovy                            # 进入交互式 REPL
chovy chat "..."                 # 一次性
chovy goal "<objective>"         # 长程任务入口（step-23 前为占位）
# REPL 内也可输入 /goal <objective>
chovy mem list|search|show       # 记忆查询
chovy agent list                 # 列子 agent
chovy provider list              # 列 provider
chovy log tail                   # 看 telemetry
```

---

## 12. 与本仓库相关的术语表

| 缩写 | 全称 | 含义 |
|---|---|---|
| ATP | Adaptive Tool Protocol | 工具描述 lean/full 双重 + 运行时预算选择 |
| SwarmR | Swarm Router | 主→N 子 agent 一次派发 + 裁判聚合 |
| TMT | Tiered Memory Tree | 4 层记忆 + sqlite + FTS5 |
| SCW | Smart Context Window | 自适应阈值 + 自动 checkpoint + 重建 + 预算化注入 |
| CSG | Conditional Skill Graph | 技能依赖图 + Planner |
| PSF | Prompt Shape Fingerprint | 通用化 prompt 稳定性诊断 |
| PCM | Provider Capability Matrix | 能力声明 + 降级路径 |
| B1–B4 | Barrier 1–4 | architecture.md §3 中四个并行屏障同步点 |

---

## 13. 出现问题怎么办

- 先 `chovy log tail` 看 telemetry；
- 看 `~/.chovy/telemetry/<date>.jsonl` 找事件 type；
- `bun run typecheck` 看类型错；
- 在 `docs/step-XX-*.md` 的"风险"段查是否已知；
- 仍未解决：开 issue 用上面 PR 模板的"关联"格式，把 step 路径贴上。

---

## 14. 致谢与边界

- 灵感来源：`cc-haha`（多模块借鉴）、Claude Code（设计哲学）、Codex（goal loop 思路）。
- 本仓库**与上述项目无附属关系**；许可证为 MIT。
- 5 项核心创新是 chovy-code 自身设计——欢迎在 docs/innovations.md 上提改进 PR，但请保留命名以维持文档一致。

---

最后：**先读 docs，再动手；接口冻结后别私改；least privilege 永远赢。**

---

## 15. Phase A 验收追记（2026-06-18）

- step-01–05 已按 `docs/complete/step-01-05-acceptance.md` 完成验收追补。
- Windows 下 `config.json` / `features.json` 可能带 UTF-8 BOM；配置层必须在解析 JSON 前兼容 BOM。
- CLI 子命令必须统一走 `resolveCtx()`，确保 `CHOVY_HOME`、feature flag、permission mode、config 校验语义一致。
- 非 TTY 下无参 `chovy` 不应尝试进入 Ink REPL；应给出明确 `CONFIG_INVALID` 提示，让用户改用 `chovy chat "..."`。
- CLI 捕获到 `ChovyError` 时必须把 Error 对象交给 logger，不能先转成 `.message` 字符串，否则会丢失 `chovy.error: <CODE>` 规范输出。

## 16. Step 06–07 验收追记（2026-06-18）

- B1 屏障已验收：`Tool` / `ToolContext` / `ToolResult` / `DescribeOptions` / `DescribedTool` 签名可供下游依赖。
- `Tool.run` 兼容旧工具的同步或异步 `string` 返回；agent loop 会包装为 `{ ok: true, content }`。
- ATP 分配器必须在 `budgetTokens <= 0` 时仍裁掉 lean 描述，不能无视预算注入全部工具。
- `fullTriggers` / verb 正则匹配前要复位 `lastIndex`，避免带 `g` 的正则造成间歇性漏命中。
- 验收报告见 `docs/complete/step-06-07-acceptance.md`。

## 17. Phase B 验收追记（step-06–11，2026-06-18）

- step-06–11 已按 `docs/complete/step-06-11-phase-b-acceptance.md` 完成验收追补。
- **`tool.call` telemetry 单源**：agent loop wrapper 是唯一发射点，工具内部**禁止** emit `{type:"tool.call",...}`。需要更细粒度信息走 `ToolResult.meta`（`durMs / bytes / cmd / filesChanged`）或 `structuredOutput`。step-27 上下文阈值监控、step-30 计数测试都按这个不变量编写。
- **`AgentRole` 单源**：`src/types/agent.ts` 是唯一定义；`src/telemetry/events.ts` 通过 `export type { AgentRole } from "../types/agent.js"` 复用。step-19 真实化时只动 `types/agent.ts`，`events.ts` / `relevance.ts` / agent loop 自动跟随。**禁止**在 `events.ts` 重新声明字面量。
- **`ToolContext` 必须由 agent loop 注入**：`runAgent()` 入口构造最小 ctx（`cwd / abortSignal / logger / permissions:{} / hooks:{} / config / sessionId / projectId / session / askUser / isInteractive`），并把 ctx 传给 `tool.run(args, ctx)`。step-12/13/16/22 的扩展应**追加**字段而非替换 ctx。
- **bash 必须接 `ctx?.abortSignal`**：`execShellCommand` 的 spawn 选项已支持，本步实接。新工具如要做长任务，**必须**透传 `ctx?.abortSignal` 到内部 fetch / spawn / setTimeout。
- 子 agent（step-18）**必须**为 `ctx.abortSignal` 创建独立 `AbortController`，不能共用父 agent 的 signal（AGENTS.md §9 既有红线，本步在 ctx 模型层面留好接口）。
- `ask_user_question` 在 `ctx.askUser` 缺席时返回 `INTERNAL → step-22`，在非 TTY 下返回 `TOOL_DENIED`，**绝不**阻塞 stdin；step-22 落地 `AskUserOverlay` 时只接 `runAgent({askUser, isInteractive})`。
- `todo_write` 的会话 todo 现在通过 `ctx.session.todoList` 存活（agent loop 注入空数组），module-level fallback 仅在裸调（如 smoke 脚本）时启用。

## 18. Step 12 验收追记（权限引擎，2026-06-18）

- step-12 已按 `docs/complete/step-12-permission-engine.md` 完成构建与验收。6 层决策 + 5 模式 + 拒绝熔断器落地于 `src/harness/permissions/`。
- **`PermissionMode` 单源**：字面量联合**只在 `src/config/config.ts`** 声明；`src/harness/permissions/modes.ts` 仅 `export type { PermissionMode } from "../../config/index.js"`，**禁止**在 harness 层重声明字面量（与 §17 `AgentRole` 单源同例）。
- **`PermissionEngine` 接口未改字段名**：step-06 冻结的 `preflight?(toolName, args)` 保持；agent loop 把 `hasPermission` 绑定为该 handle 的实现。step-13/14/22 的扩展**追加** `PermissionEngineState` 字段或新增调用点，不替换冻结接口。
- **L1g 安全检查对所有模式免疫**（含 `bypassPermissions`）：`.gitconfig`/`.bashrc`/`.zshrc`/`.profile`/`.ssh`/`.aws/credentials`/`.git/`/`.chovy/secrets/`/`--no-verify` → deny；`git push --force`/`-f`/`--force-with-lease` → ask。这是 AGENTS.md §5 红线的代码化，step-14 沙箱在 engine 之下分层，**不得**绕过 L1g。
- **L3/L4 调序**：`acceptEdits` 的 fs-mutate 自动放行与 `auto` 的安全工具放行必须**先于** `dontAsk→deny` 转换（L3），否则非交互 `acceptEdits`/`auto` 运行会把每次写/读都拒掉。deny 规则（L1a）与 safety deny（L1g）仍在最前。step-13 接 L5 hook 时维持此序。
- **非交互 `default` 模式下 bash 普通命令被拒是预期行为**：bash preflight 对非只读命令返回 `ask`，非 TTY → ask→deny。用户需 `--permission-mode acceptEdits`/`bypassPermissions` 或写 allow 规则。**不要**为了让 `chat "..."` 跑 bash 而把 default 改成放行——安全默认优先。
- **`auto` 模式无小模型**：白名单 + step-09 `isAllReadOnly` 命令分类，未识别回退 `ask`。`feature('auto.classifier')` 留桩，默认 off（AGENTS.md §5 红线 + innovations §10）。
- **规则匹配 `g` 正则陷阱**：`matchWildcardPattern` 每次**新建** RegExp，不复用带 `g` 的实例（§16 既有追记的本步实例化）。
- **rules.json 缺失静默**：`loadRulesFromPaths` 对 ENOENT 静默跳过（errno 从 `ChovyError.meta.errno` 提取，因 safeFs 把 node errno 包进 `MEMORY_IO`）；坏 JSON/坏行 warn + 跳过，不抛。
- **harness→tools 边**：engine 只 reach `tools/exec/ast.js` + `tools/exec/classification.js` 两个零外部依赖纯函数叶子，不引入 tool registry，无循环。后续 harness 模块需复用 tools 纯函数时照此例 reach 叶子而非 barrel。
