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

当前阶段：**Phase A-I 全部完成构建并通过复验；step-30（端到端集成）已落地**。核心验收报告见 `docs/complete/phase-a-e-acceptance.md`、`docs/complete/phase-a-g-acceptance.md`、`docs/complete/step-27-acceptance.md`、`docs/complete/step-28-acceptance.md`、`docs/complete/step-29-acceptance.md`、`docs/complete/step-30-acceptance.md`。
阶段划分（详见 `docs/README.md §1`）：A=01–05、B=06–11、C=12–14、D=15–17、E=18–22、F=23、G=24–26、H=27–28、I=29–30。
每一步的产物/验收报告见 `docs/complete/`；本文不重复逐步进度。

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
    ├── agent/                # runAgent / runQuery 兼容 shim → QueryEngine
    ├── engine/               # QueryEngine 主循环 + costTracker + streamHandler + messageNormalize + toolExecutor
    ├── prompts/              # 5 层 system prompt + boundary + PSF（fingerprint）
    ├── cli/index.tsx         # commander 入口（subcommands + REPL 路由）
    ├── cli/repl.tsx          # step-05 交互式 REPL 主屏
    ├── cli/components/       # AgentRepl / StatusLine / HeaderBar / MessageList
    ├── config/               # zod 配置合并 + secrets + features
    ├── fs/                   # chovy home / project paths / safeFs
    ├── logger/               # 结构化 logger
    ├── telemetry/            # 本地 JSONL telemetry sink
    ├── providers/            # 7 真实 provider + PCM + 通用 SSE + toolFormat 适配
    ├── tools/                # Tool v2 registry + ATP allocator + echo + fs / exec / web / meta 工具
    ├── harness/              # 缰绳层：permissions / hooks / sandbox
    ├── agent/                # runAgent / QueryEngine shim + 子 Agent 运行时（pool / lifecycle / snapshot / builtin / outputBuffer / swarmBus）
    ├── swarm/                # SwarmR：router / pool-wrapper / concurrency / budgets / progress bus / judge / schemas
    ├── engine/               # QueryEngine 主循环 + costTracker + streamHandler + messageNormalize + toolExecutor + runtimeRegistry + runHelpers
    ├── memory/               # TMT 存储底层（store + parser + migrations + files + syncFromFiles + checkpointWriter）
    └── types/                # provider / messages / tool / agent / memory 契约
```

**已具备**：Bun + Ink 工具链、Provider/Tool 注册中心、QueryEngine 主循环（5 层 system prompt + ATP 描述选择 + 6 层权限 + 12 hook 事件 + 流式 + 成本追踪 + 取消协议）、Tool Protocol v2（lean/full 描述 + ATP 预算分配器）、10 个核心工具（fs / exec / web / meta 含 dispatch）、Harness 缰绳层（权限引擎 6 层决策 + hook 引擎 12 事件 + 文件系统/命令沙箱）、7 个真实 provider（OpenAI / Anthropic / Gemini / DeepSeek / GLM / Kimi / MiniMax）+ PCM 能力矩阵 + 通用 SSE 解析 + 工具格式适配（含 MiniMax json-mode 降级）、子 Agent 运行时（SubAgentHandle 状态机 + pool 100 上限 + 父→子上下文快照 + 取消 cascade + 后台执行 + 5 内置角色）、SwarmR dispatch 核心（并行 fan-out ≤100 + 异构 provider 路由 + 自实现 p-limit 并发限流 + 全局预算 sticky-trip 熔断 + 进度/生命周期 bus）、Judge 聚合（4 schema + provider fallback 链 + tryFixJSON 五步修复 + ≤1 次自我修复 + 大 N 截断 + 取消独立 AC）、Ink UI 面板（SwarmPanel + AgentRow + AgentDetail + HotkeyBar + swarmStore + outputBuffer + Tab 焦点 + 16ms 节流）、`/goal` 长程任务循环（GoalState 5-state + JSON 持久化 + Loop-driven Stop + rubric/command/hybrid 收敛 + 死循环兜底 + checkpoint per-5-rounds + GoalPanel + 3-way Tab 焦点 + headless 退出码）、**TMT 存储底层（4 类记忆 schema 冻结 + bun:sqlite + FTS5 unicode61 + BM25/mixed ranker + InMemoryStore 降级 + frontmatter+bullets parser + 增量 sync mtime 缓存 + forceRebuild + memoryFile/notesFile/progressFile + memory.index telemetry + chovy mem list/show/search/rebuild/stats）**、**Checkpoint Writer（CheckpointCoordinator 30s/reason 防抖 + 路径沙箱 via ToolContext.agentRole + 7 段 markdown 模板 + ≤50 归档轮转 + 规则化 fallback + checkpoint.written telemetry + /checkpoint now|list slash + goal-loop per-5-rounds 触发 + 取消独立 AC）**、**Context Monitor（自适应阈值 thresholds() PCM 单源 + 4chars/token×1.2 安全估算 + ContextMonitor 3-state fresh/soft/hard + 上转换 sticky max-level + soft 自动 maybeCheckpoint('token-soft') + `<context-pressure level=…>` system prompt 注入 + HeaderBar 实时 ctx % + soft黄/hard红着色 + onContextSnapshot/onUsage UI 回调 + CHOVY_CTX_DISABLE 开关 + context.threshold telemetry 单源）**。**Phase G 复验（`docs/complete/phase-a-g-acceptance.md`）闭合 step-24 ↔ step-26 bridge**：coordinator 写出的 `checkpoints/*.md` 经 `syncFromFiles` file-primary 路径落 MemoryStore（`layer=checkpoint`）+ FTS 可检索，已由 smoke-step26 §13 覆盖。

**已完成**：跨会话记忆注入（step-25 glue via `memory/injection.ts` + `engine/memoryHook.ts`）、上下文重建 step-28、技能图 CSG step-29、端到端集成 step-30（USAGE/DEVELOPING/KNOWN-LIMITATIONS、跨平台 `bun run demo`、总 smoke、bench、mock E2E）。

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
# REPL 内可输入 /checkpoint now | list   # step-26 强制生成 / 列归档
chovy mem list|search|show       # 记忆查询
chovy agent list                 # 列活跃子 agent（pool 快照）
chovy agent list --builtins      # 列 step-19 注册的 5 内置角色 + ACL + memory
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

## 15. Phase A 不变量（Foundation）

> Phase A（step-01–05）产物/验收见 `docs/complete/step-01-05-acceptance.md`。本节只保留跨步骤仍生效的不变量。

- Windows 下 `config.json` / `features.json` 可能带 UTF-8 BOM；配置层必须在解析 JSON 前兼容 BOM。
- CLI 子命令必须统一走 `resolveCtx()`，确保 `CHOVY_HOME`、feature flag、permission mode、config 校验语义一致。
- 非 TTY 下无参 `chovy` 不应尝试进入 Ink REPL；应给出明确 `CONFIG_INVALID` 提示，让用户改用 `chovy chat "..."`。
- CLI 捕获到 `ChovyError` 时必须把 Error 对象交给 logger，不能先转成 `.message` 字符串，否则会丢失 `chovy.error: <CODE>` 规范输出。

## 16. Phase B/C 不变量（Tool System v2 + Harness）

> Phase B（step-06–11）与 Phase C（step-12–14）产物/验收见 `docs/complete/` 下各报告。本节只保留跨步骤仍生效的不变量；后续 Phase 扩展对应模块时必须遵守。

**单源规约**（字面量联合只在一处声明，harness/telemetry 层 re-export，禁止重声明）：
- `AgentRole` → `src/types/agent.ts`；`events.ts` 通过 `export type` 复用。
- `PermissionMode` → `src/config/config.ts`；`harness/permissions/modes.ts` 仅 re-export。
- `HookEvent` → `src/types/hook.ts`；`harness/hooks/index.ts` 仅 re-export。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `Tool` / `ToolContext` / `ToolResult`（step-06 冻结）：`ToolContext` 必须由 agent loop 注入，`runAgent()` 入口构造 ctx（`cwd / abortSignal / logger / permissions / hooks / config / sessionId / projectId / session / askUser / isInteractive`）并传给 `tool.run(args, ctx)`；后续扩展**追加**字段而非替换 ctx。
- `PermissionEngine.preflight?(toolName, args)`（step-06 冻结）：agent loop 把 `hasPermission` 绑定为该 handle；扩展**追加** `PermissionEngineState` 字段或新增调用点，不替换。
- `HookEngine.emit?(event, payload)`（step-06 冻结）：追加可选 `runPermissionRequest?` handle（追加 permitted，rename 不 permitted）；`tool.ts` 用 `import type`（不 re-export）避免 barrel 双导出冲突。

**telemetry 单源**：
- `tool.call` 事件只在 agent loop wrapper 发射，工具内部**禁止** emit；细粒度信息走 `ToolResult.meta`（`durMs / bytes / cmd / filesChanged`）或 `structuredOutput`。
- `hook.run` 事件只在 hook engine（`engine.ts`）发射，runners 禁止 emit。`outcome` 5 态：`ok` / `blocked` / `bypassed` / `error` / `timeout`。

**Tool / ATP 不变量**：
- `Tool.run` 兼容旧工具的同步或异步 `string` 返回；agent loop 包装为 `{ ok: true, content }`。
- ATP 分配器在 `budgetTokens <= 0` 时仍裁掉 lean 描述，不能无视预算注入全部工具。
- `fullTriggers` / verb 正则匹配前要复位 `lastIndex`，避免带 `g` 的正则造成间歇性漏命中。规则匹配 `matchWildcardPattern` 每次**新建** RegExp，不复用带 `g` 的实例。

**权限引擎不变量**：
- L1g 安全检查对所有模式免疫（含 `bypassPermissions`）：`.gitconfig`/`.bashrc`/`.zshrc`/`.profile`/`.ssh`/`.aws/credentials`/`.git/`/`.chovy/secrets/`/`--no-verify` → deny；`git push --force`/`-f`/`--force-with-lease` → ask。这是 §5 红线的代码化，沙箱在 engine 之下分层，**不得**绕过 L1g。
- L3/L4 调序：`acceptEdits` 的 fs-mutate 自动放行与 `auto` 的安全工具放行必须**先于** `dontAsk→deny` 转换（L3）；deny 规则（L1a）与 safety deny（L1g）仍在最前。L5 hook 在 L1/L4 之后，不能 override deny 规则或 safety trip。
- 非交互 `default` 模式下 bash 普通命令被拒是预期行为（bash preflight 非只读 → ask，非 TTY → deny）。**不要**为了让 `chat "..."` 跑 bash 而把 default 改成放行——安全默认优先。
- `auto` 模式无小模型：白名单 + 只读命令分类，未识别回退 `ask`；`feature('auto.classifier')` 留桩默认 off（§5 红线 + innovations §10）。
- L5 竞速：`runPermissionRequest` 返回 decisive `allow`/`deny` 短路 L6；`undefined`（旁路）落 L6。**`{ok:true}` 不 decisive**——只有 `{ok:false}` 或显式 `permissionDecision:"allow"` 才决策成功。

**Hook 引擎不变量**：
- 启动快照防热改：`createHookEngine` 构造时读盘一次 → 冻结 in-memory 副本；本会话所有 emit/runPermissionRequest 读副本，**不重读盘**。
- Trust 边界：`~/.chovy/trust.json`（`{ "<normalizedCwd>": true }`）+ 父目录继承；未信任 cwd 只跑 `managed:true` 钩子，拒绝用户写的 command/function 钩子。
- 超时默认 2000ms、硬上限 10000ms；Windows killTree 用 `taskkill /T /F`，POSIX 用进程组信号（`detached:true` spawn + `process.kill(-pid)`）。
- agent loop 发射点：SessionStart / PreToolUse（block 短路）/ PostToolUse / PostToolUseFailure / PermissionDenied / SessionEnd。PostToolUse 钩子失败 **≠** 工具失败（仅记 telemetry）。

**bash / ctx 不变量**：
- bash 必须接 `ctx?.abortSignal`；新工具做长任务**必须**透传 `ctx?.abortSignal` 到内部 fetch / spawn / setTimeout。
- 沙箱环境过滤必须在 Windows 下兼容 `Path` / `PATH` 大小写差异，并向子进程输出规范 `PATH`，否则降级沙箱会丢失可执行文件搜索路径。
- 子 agent **必须**为 `ctx.abortSignal` 创建独立 `AbortController`，不能共用父 agent 的 signal（§9 既有红线）。
- `ask_user_question` 在 `ctx.askUser` 缺席时返回 `INTERNAL`，非 TTY 返回 `TOOL_DENIED`，**绝不**阻塞 stdin。
- `todo_write` 的会话 todo 通过 `ctx.session.todoList` 存活（agent loop 注入空数组），module-level fallback 仅裸调时启用。

**harness→tools 边**：harness 模块是叶子，只 reach `tools/exec/ast.js` + `tools/exec/classification.js` 等零外部依赖纯函数叶子，不引入 tool registry，无循环。后续 harness 模块复用 tools 纯函数时照此例 reach 叶子而非 barrel。hook 层 shell 选择 + killTree 独立实现，不 reach `tools/exec/bash.ts`；matcher 通配语法是 `rules.ts` 的精简端口（不 import）。

**rules.json / settings.json 缺失静默**：ENOENT 静默跳过（errno 从 `ChovyError.meta.errno` 提取，因 safeFs 把 node errno 包进 `MEMORY_IO`）；坏 JSON/坏行 warn + 跳过，不抛。

## 17. Phase D 不变量（Agent Core：System Prompt + QueryEngine + Providers）

> Phase D（step-15–17）产物/验收见 `docs/complete/step-15-system-prompt.md`、`step-16-acceptance.md`、`step-17-providers-real.md`、`phase-a-d-acceptance.md`。本节固化跨步骤生效的不变量；后续 Phase E-I 扩展对应模块时必须遵守。

**单源规约**（接 §16 同模式；字面量/数据只在一处声明，下游 re-export，禁止重声明）：
- `SystemPromptLayer` → `src/prompts/builders.ts`（step-15 冻结）：`override`/`coordinator`/`agent`/`custom`/`default` 5 层；后续 step-16/19 通过 `import type` 复用，禁止重声明。
- `PromptShape` → `src/prompts/fingerprint.ts`（step-15 冻结）：`telemetry/events.ts` 仅 `export type` 透传；step-16+ 用 `import type { PromptShape } from "@chovy/prompts"` 或 telemetry barrel。
- **PCM 单源**：`src/providers/capabilities.ts` 是 7 provider 能力 + 价格的唯一权威。`engine/costTracker.ts` 的 `PROVIDER_DEFAULTS` 通过 IIFE **结构性派生**自 `CAPS.pricing`（不再手抄表，避免漂移）；`DEFAULT_PRICES` 的 per-model 行仍然是 SKU 级覆盖，与 PCM provider 兜底解耦但不得倒挂（PR 调整 PCM 价格时无需改 PROVIDER_DEFAULTS，自动同步）。
- **SSE 单源**：`src/providers/streaming.ts` 是 chovy-code 唯一的 SSE 解析器。新增 provider 只在 `mergeDelta(family, ...)` 加 case + 在 `capabilities.ts` 声明 `family`，**禁止**另写解析器。
- **Tool 格式单源**：`src/providers/toolFormat.ts` 把 zod→JSON schema→各家原生格式收敛在一处。Provider 内部不允许直接 `Object.entries(zodSchema)` 自行转换。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `BuildOptions` / `EffectivePrompt` / `SystemContext`（step-15 冻结）：boundary 标记位置 `<!--chovy:dynamic-->` 必须出现在 default prompt **之后**、动态片段**之前**；override 路径无标记是合法的（PSF 仍能算）。
- `QueryEngine.run(opts)` / `QueryRunOptions` / `QueryRunResult` / `StopReason`（step-16 冻结，B2 屏障）：扩展**追加**字段；调用方一次性 prompt 走 `runAgent(prompt, opts)`、多轮走 `runQuery(messages, opts)`，子 agent / swarm / goal **直接** `new QueryEngine().run({...})`。
- `Provider.complete` / `Provider.stream` 增强签名（step-17 冻结，B3 屏障）：`ProviderRequestOptions.toolSpecs?: ProviderToolSpec[]` 是新增可选字段（不改 `tools: string[]`），让 ATP 已选 lean/full 直接下发。

**telemetry 单源**：
- `prompt.shape` 事件**只**由 QueryEngine 每轮发射一次（`queryEngine.ts:run` 内部）；shape 字段类型 = 真实的 `PromptShape`（来自 prompts/fingerprint），不再是占位结构。
- `agent.cost` 事件**只**由 `engine/costTracker.ts` 的 `record()` 发射；QueryEngine 不直接 emit；usage 走 `usage` 字段。
- `agent.start` / `agent.end` 事件由 QueryEngine 发射（agent 生命周期单源）；子 agent 在 step-18 落地后保持同一来源。

**5 层 system prompt 不变量**：
- `override` 短路其它 4 层（含 `defaultAppend`）；其余 `coordinator → agent → custom → default(+append)` 顺序前置堆叠。
- `agent.omitMemory:true` 跳过动态 memory/notes 段（least-context；步骤 19 explore 角色用）。
- `planMode:true` 在 default 静态侧追加 `PLAN_NOTE`——**故意**放静态侧：一次会话内 mode 稳定，PSF 缓存仍受益；切 mode 等价于切 session（staticHash 必变）。
- 默认 prompt 不引入时间戳 / 随机性 / cwd / model id，否则破坏 staticHash 稳定性。

**PSF（Prompt Shape Fingerprint）不变量**：
- 算法固定为 **FNV-1a 32-bit 纯 TS**（`Math.imul` + `>>> 0` 转无符号），不依赖 `Bun.hash`；`stableJson` 递归排序键，保证 `{a:1,b:2}` 与 `{b:2,a:1}` 同 hash（防 ATP 迭代顺序震荡）。
- `perToolHash` 三元素 = `level | description | stableJson(schema)`；任一变更必反映在 hash 上（验收 4）。
- `toolsHash = fnv1a(toolNames.join("|"))` 与 ATP 输出顺序绑定；同输入是确定性的。

**取消信号不变量（QueryEngine）**：
- engine 内**本地 AbortController** 包装外部 `opts.abortSignal`（§9 红线："不共享父 signal" 的代码化）；budget 超限等程序内取消用 `ac.abort()`，不污染调用方 signal。
- 检测点：每轮入口 / `runStream` for-await 内 / assistant 推入后 / `executeToolCall.invokeTool` 包装层；任意一处感知 abort → `stopReason='cancelled'`。
- `cancelGraceMs`（默认 2000ms）让工具优雅退出；超时返回 `{ ok:false, content:"Tool cancelled by user (timed out…)", errorCode:"INTERNAL" }`。
- fetch `AbortError` 在 `providers/common.wrapNetwork` 中**直接 rethrow**，不包装成 `PROVIDER_API_ERROR`，确保取消语义不被 provider 错误遮蔽。

**Provider 真实接线不变量（step-17）**：
- 工具支持 3 模式：`native`（OpenAI/Anthropic/Gemini/DeepSeek/GLM/Kimi）/ `json-mode`（MiniMax）/ `no`（保留态）。MiniMax json-mode 降级路径冻结：`<tool_use>{"name":..,"arguments":..}</tool_use>` envelope；① system prompt 注入由 `toJsonModePromptInjection` 统一产生；② 流式路径在还原前不向 UI 转发原始 token；③ 解析端永远兜底（envelope 非法即丢弃）。
- **OpenAI 兼容广播**：DeepSeek / Kimi / GLM / MiniMax 都通过 `createOpenAICompatProvider` 工厂构造；新增 OpenAI 兼容渠道优先走工厂，**不**复制粘贴 fetch 代码。
- **Auth header 边界**：每个 provider 的 `auth(apiKey)` 是构造 header 的唯一入口（`Authorization: Bearer` / `x-api-key` / `?key=`）；不允许在 `complete/stream` 内联手写。
- **`toolSpecs` 优于 `tools: string[]`**：`toolSpecs` 非空时 provider **必须**消费它（ATP 已选的 lean/full）；否则才走 registry 默认 lean。
- HTTP 错误归一：非 2xx 包成 `ChovyError(PROVIDER_API_ERROR / PROVIDER_RATE_LIMIT)`，meta 带 `provider/url/status/bodySnippet`；上层捕到后走 `stopReason='final'` 早退路径。

**queryEngine.ts 体量约束**：
- step-16 spec §风险 + AGENTS.md §8：`src/engine/queryEngine.ts` ≤ 600 行（**硬限**）。phase-a-e 复验（P6）做了二次拆分以维持该不变量：
  - 工具执行子流程（`executeToolCall` / `invokeTool`）→ `src/engine/toolExecutor.ts`（phase-a-d P1 抽离）
  - SubAgentSpawn / SwarmRDispatch builder 注册存储 → `src/engine/runtimeRegistry.ts`（phase-a-e P6）
  - 纯 helper（`resolveToolPool` / `runPreflight` / `fillBuildOptions` / `makeAgentId`）→ `src/engine/runHelpers.ts`（phase-a-e P6）
  当前主文件 ~557 行，聚焦"主循环 + 取消协议 + run() 入口"。后续要新增主循环阶段（如 SCW 钩子）请优先扩展 helper / 抽到新 leaf 模块，**不要**把逻辑塞回 queryEngine.ts。`setSpawnFnBuilder` / `setDispatchFnBuilder` 经 queryEngine.ts re-export 保持公共 API 不变；调用方继续从 `engine/index.ts` import，无须改路径。

**engine→providers 边**：`engine/costTracker.ts` import `providers/capabilities.CAPS` 是允许的（叶子直达，避免循环）；engine 不应 import provider 的具体 `complete/stream` 实现，统一通过 `providers/getProvider(id)` 拿 `Provider` 接口。

## 18. Phase E 不变量（Sub-Agent + SwarmR）

> Phase E（step-18–22）产物/验收见 `docs/complete/step-18-acceptance.md` ~ `step-22-acceptance.md` + `docs/complete/phase-a-e-acceptance.md`。本节固化 step-18~22 跨步骤生效的不变量；后续 Phase F-I 扩展对应模块时必须遵守。

**单源规约**（接 §16/§17 同模式）：
- `BuiltInAgentDefinition` → `src/types/agent.ts`（step-19 冻结）；5 内置角色（explorer / planner / verifier / critic / checkpoint-writer）通过 `src/agent/builtin/{exploreAgent,planAgent,verifyAgent,criticAgent,checkpointWriterAgent}.ts` + `registry.ts` 注册。`getSystemPrompt(ctx: SystemContext)` 是动态函数（不是静态字符串），便于角色 prompt 读 cwd / model / planMode。
- **TOOL_PHASE 表键名 = registry 工具名（registry 单源）**：`src/agent/pool.ts` 的 `TOOL_PHASE` 表用于 SwarmPanel "⏳ <phase>" 标签，**键名必须**匹配 `src/tools/<family>/*.ts` 的 `name` 字段（`file_read` / `file_write` / `file_edit` 等）。phase-a-e 复验 P4 修复键名漂移；新增工具时需同步追加，否则 phase 退化到 `running <name>` fallback。
- `DispatchRole` / `JudgeSchemaName` → `src/swarm/router.ts`（step-20 冻结）；wire schema 的 `explore/plan/verify/critic/custom` 与 runtime `AgentRole`（`explorer/planner/...`）经 `toAgentRole()` 映射，**不**重声明 union。
- `DispatchInput` / `DispatchOutput` / `DispatchChildResult` → `src/swarm/router.ts`（step-20 冻结，B4 屏障）；后续 step-21（Judge）/ step-23（goal）扩展**追加**字段，不替换。
- **handle 状态 + `subagent.*` telemetry 单源仍在 `agent/pool.ts`**：swarm 模块是 handle 状态的*观察者*（poll cost/phase 发 swarmBus 事件），**不**是 telemetry 第二发射源。`swarm.dispatch` telemetry 只由 `dispatch()` 发射一次（n + parallelism）。
- **swarmBus 是 UI 通道，非 telemetry**：`progress` / `lifecycle` / `cost` 事件由 step-22 Ink SwarmPanel 订阅；它们**永不**写 `~/.chovy/telemetry/`，与 `subagent.spawn` / `subagent.end` / `swarm.dispatch` 互不替代。`useSwarmState` 16ms 节流，`outputBuffer` 2KB 环形 + 60s TTL。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `ToolContext.dispatchSwarm?: DispatchSwarmFn`（step-20 追加，§16 兼容）：QueryEngine 在 `role === "main"` 时通过 `setDispatchFnBuilder` 注入；子 agent 默认拿不到（避免递归 fan-out，step-20 显式留给后续 step opt-in）。
- `DispatchInput.abortSignal?`：caller-controlled 取消；路由器用**本地** AC 包装（§9 红线）。
- `DispatchOutput.stopReason`：`final` / `budgetExceeded` / `cancelled`（step-20 冻结；step-21 judge 失败不应新增 stopReason，走 `judgement` 字段）。

**依赖图无环**：
- `engine/queryEngine.ts` **不**直接 import `swarm/router`（会成环 engine → swarm → agent → engine）；沿用 step-18 `setSpawnFnBuilder` 间接注册模式：`setDispatchFnBuilder(builder)` 由 `agent/runAgent.ts` 在 import 时调用一次。
- `swarm/pool.ts` 直接 reach `agent/pool.js`（**不**经 `agent/index` barrel）——barrel re-export `runAgent`，而 `runAgent` 落地 SwarmR 后 import `swarm/router`，会闭合环。reach 叶子模块保持 DAG（§16 `harness→tools` 边同模式）。

**取消传播不变量（SwarmR）**：
- 路由器**本地 AbortController** 包装外部 `input.abortSignal`（§9 红线代码化）；budget 超限 / 外部 abort 都 `ac.abort()`，不污染调用方 signal。
- 子 agent AbortController 在 step-18 pool 内从 `parentCtx.parentSignal` cascade——**不**从路由器的 `ac` cascade。因此路由器在 `ac` abort 时**显式调** `swarmPool.cancelAll()` 把取消传播到所有未完成子 agent（外部 abort + 预算熔断两条路径都走这个 listener）。
- 取消后 `stopReason='cancelled'`；未完成子 agent 状态 `cancelled`（pool 的 `runChild` 把 abort 映射为 cancelled，超时才映射为 failed）。

**并发限流不变量**：
- parallelism 由 `src/swarm/concurrency.ts` 自实现 p-limit 限流：slot 在 `run()` 中**恰好 claim 一次**（fast path 直接 `active++`；waiter 被 wake 后**重新检查** `active >= concurrency` 再 claim，避免双计数 / 超 cap）。
- pool 的 100-active 硬上限仍在 step-18 pool（`MAX_SUB_AGENTS`）；路由器 `swarmPool.canFit(prompts)` 做预检——`prompts.length + activeCount ≤ 100` 否则抛 `AGENT_BUDGET_EXCEEDED`，**不**在 dispatch 中途才溢出。

**全局预算不变量**：
- `GlobalBudget` sticky trip：一旦 `totalUSD >= cap` 永久 `exceeded=true`，watchdog 每 100ms 轮询 handle 累计 cost 重算；trip 时 `cancelAll()`。
- 预算在 **spawn 前**也检查（已 trip → 跳过 spawn + 标 cancelled），避免 budgetExceeded 后还继续 fan-out。
- `budgetUSD` undefined / 非有限正数 → 预算 inert（`exceeded` 永远 false），对齐 QueryEngine `Infinity` 默认。

**失败隔离不变量**：
- 单个子 agent 失败**不**中断兄弟：其结果 slot `ok:false` + `status:'failed'`，judge（若启用）被告知"该角度无有效结论"。
- 只有全局 budget 超限 / dispatch-level abort 取消整个 fan-out（`stopReason` 非_final）；单个失败保持 `stopReason='final'`。

**Judge 聚合不变量（step-21）**：
- **judge 不是 telemetry 源**：judge 的 cost 折进 dispatch 的 `totalCostUSD`（router 在 judge 返回后 `+= judgement.costUSD`），但 judge **不** emit 任何 telemetry 事件（`swarm.dispatch` 仍是单源，§17）。`CostTracker` 实例 `telemetry:false`。
- **judge 失败不致命**：`judge.enabled:true` 时 dispatch 仍成功——judge 失败走 `judgement.ok=false` + `reason`（`parse`/`cancelled`/`no-provider`），`stopReason` **不**新增（§18 冻结：`final`/`budgetExceeded`/`cancelled`）。主 agent 仍拿到原始 `results[]`。
- **judge 取消独立 signal**：judge 用**本地** AbortController 包装 dispatch 的 `ac.signal`（§9 红线：不共享 dispatch signal 对象）。dispatch 已 abort 时 router 跳过 judge 调用（`judgement` 留 `undefined`）。
- **provider 选择 fallback 链**：caller `judge.provider/model` 覆盖 → 长上下文 fallback 链（Kimi-K2 → GLM-4.5 → DeepSeek-V3 → Gemini-2.5-pro → Claude Sonnet 4，均经 `hasSecret` 门控）→ 父 provider（也经 `hasSecret`）。全部不可用 → `ok=false / reason:'no-provider'`，**不**抛。
- **schema 单源**：`ConsensusSchema` / `CompareSchema` / `RankSchema` / `CustomMeta` → `src/swarm/schemas.ts`（step-21 冻结）。`judge.ts` 的 `schemaFor(name, customSchema)` 是唯一选择入口；`router.ts` 的 `JudgeSchemaName` union **不**重声明。
- **自我修复 ≤1 次**：第一次 `safeParse` 失败 → 用 repair prompt（echo 上次 raw + zod issues）重试一次；仍失败 → `ok=false / reason:'parse'`，`rawText` 保留供调试。`tryFixJSON`（去 ``` 包裹 / 截首尾 prose / 补缺括号）在每次 parse 前运行。
- **大 N 截断**：每个 agent content 截断到 ≤ 4 KB（首 2 KB + 尾 2 KB），prompt 中标注已截断。避免 N 个子 agent 完整 transcript 撑爆 judge provider ctx。
- **`DispatchDeps.runJudge?` 注入**（测试用）：router 接受 `deps.runJudge` 覆盖真实 `runJudge`，离线 smoke 注入 stub verifier。生产路径走真实 `runJudge`。

**per-prompt maxTokens 遗留**：wire schema 有 `maxTokens`，但 `SpawnInput` 当前只透传 `maxRounds`（step-18 pool 未实现 per-child token cap）。router 里 `TODO step-18 follow-up` 注释；字段保留在 schema 不删（step-20 spec 明列）。后续 step-18 扩展 `SpawnInput.maxTokens` 时 router 取消 TODO 即可。

**内置角色不变量（step-19）**：
- **least-privilege 工具合并**：caller `SpawnInput.tools` ∩ `roleDef.allowedTools`（caller **只能收紧**，不能放宽）；`disallowedTools` 取并集。空数组 = no-op（防误杀全部工具——若真要 0 工具，用 `disallowedTools` 列全名）。`mergeAllowlist` / `mergeDenylist` 在 `agent/pool.ts:runChild` 调用，并经 `_mergeAllowlistForTesting` / `_mergeDenylistForTesting` 暴露给 smoke。
- **角色定义 ≠ 安全边界**：`checkpoint-writer.allowedTools = ["file_read","file_write"]` 是工具池过滤，**不**限制写路径。step-26 必须在权限/沙箱层把写路径收紧到 `~/.chovy/projects/<hash>/checkpoints/`。
- **`subagent_type` enum 故意不含 checkpoint-writer**：`tools/meta/agent.ts` 的 zod enum 只列 Explore/Plan/Verify/Critic；checkpoint-writer 由 step-26 / SCW 直接 `pool.spawn({role:"checkpoint-writer"})` 调用，不暴露给主 agent。
- **`omitMemory` 透传**：`BuiltInAgentDefinition.omitMemory` → `AgentPromptInput.omitMemory` → `prompts/builders.ts` 跳过动态 memory 段（节省 token）。explorer / checkpoint-writer 默认 true；planner / verifier / critic 默认 false。
- **优先级**：caller `SpawnInput` > `roleDef` > 全局默认。`provider` / `model` / `budgetUSD` / `timeoutMs` / `maxRounds` 全部按此优先级合并。

**Agent UI 不变量（step-22）**：
- **swarmBus 是 UI-only 进程内 pub/sub**（接 §18 单源）：`src/agent/swarmBus.ts` 永不持久化；`subagent.spawn` / `subagent.end` telemetry 仍由 pool 单源发射。
- **`SubAgentHandle` 字段冻结**：step-22 不向 handle 加任何字段。实时 phase 经 `setPhase` 写入既有 `handle.phase`；实时 tokens 经 `addUsage` 写入既有 `tokensIn/tokensOut`；流式输出经独立 `outputBuffer`（id-keyed 2KB 环形 + 60s TTL + `pool.reset()` 清空）。
- **节流 + 性能**：`useSwarmState` 16ms 节流（`setTimeout(flush, 16)` + dirty flag 合并 N 个事件 → 1 次 setState）；`useSwarmTick` 1000ms 计时；`AgentDetail` 输出预览 200ms pull；100 agent 压测 < 50ms（smoke-step22 stress 验证）。
- **键盘焦点 Tab 切换**：REPL 持 `focus: "input"|"panel"`，busy 时不切。SwarmPanel `useInput` `isActive = focused && !detail`；AgentDetail overlay `isActive = detail !== null`（互斥独占）。step-23 加 GoalPanel 时复用同一 focus state（扩展为 `"input"|"panel"|"goal"`）。
- **`CHOVY_NO_SWARM_PANEL=1`**：Windows ConHost 闪烁缓解开关，禁用面板挂载但 HeaderBar swarm chip 仍显示计数。
- **`onToken` / `onToolStart` / `onUsage` 回调 best-effort**：pool 在 `runChild` 给 `engine.run` 传这三个回调驱动 swarmBus；每个回调 try/catch + swallow——UI-only 副作用绝**不**能让子 agent run 失败。step-20 dispatch / step-23 goal 不要在 `onToken` 里做影响结果的事。

**子 Agent 取消独立 AC 不变量（再强调，§9 代码化）**：每个 `SubAgentHandle` 一个 `new AbortController()`；父 signal 仅作为 `addEventListener("abort", () => childAc.abort())` 的触发源。`pool.runChild` 把 `entry.ac.signal` 传给 `engine.run` 作 `abortSignal`，engine 内部再包一层 AC（双层包装与父隔离）。SwarmR router 也是同模式（本地 AC 包装 caller signal）。**绝不**把 `parentCtx.parentSignal` 直接传 `engine.run`。

## 19. Phase F 不变量（Goal Loop）

> Phase F（step-23）产物/验收见 `docs/complete/step-23-acceptance.md`。本节固化 step-23 跨步骤生效的不变量；后续 Phase G-I 扩展对应模块时必须遵守。

**单源规约**（接 §16/§17/§18 同模式）：
- `GoalStatus` / `ConvergenceMode` / `GoalState` → `src/types/goal.ts`（step-23 冻结）；老 draft 字段 `GoalPhase` / `ConvergenceCriteria` 标 `@deprecated` 但保留导出（grep 验证零 in-tree consumer）。
- `goal.start` / `goal.end` / `goal.iteration` telemetry 单源 = `src/goals/iterations.ts`；其它模块（CLI / GoalPanel / convergence）**不**直接发这些事件。
- rubric judge cost 折叠进 `goal.totalCostUSD`（CostTracker `telemetry:false`），与 step-21 judge 同模式；**不**单独发 `agent.cost`。
- `goalsByThread` Map 在 `src/goals/goalState.ts` 进程内独占（与 cc-haha 一致）；任何修改必须经 `createGoal/updateGoal/finalizeGoal/dropActiveGoal/loadGoal` 这 5 个 chokepoint，不允许从外部 mutate `GoalState` 引用绕过 `updatedAt` 戳记。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `RunGoalOptions` / `RunGoalResult` / `EvaluateOptions` / `EvaluateResult`（step-23 冻结，B5 屏障预留）：扩展**追加**字段；不改既有签名。
- `ReplCtx.goal: ReplGoalRuntime`（step-23 追加，§16 兼容）：5 字段（`startGoal/cancelGoal/resumeGoalLoop/findPausedGoal/setReplGoal`）+ `threadId`/`cwd`；UI-only，不 leak provider/queryEngine 引用。
- `ParsedGoalCommand` discriminated union（`type` 字段）：6 子命令分类，扩展只新增 `type` 值，不替换既有。

**Loop-driven Stop 不变量（AGENTS.md §17 Stop-hook 适配延伸）**：
- chovy-code **不**扩 `HookEvent` union 加 `Stop` 事件；goal 循环作为 outer orchestrator 截获 `result.stopReason==='final'` 决定继续/终止。
- `GoalIteration` 钩子事件保留为 *advisory* — 用户写的 hook 可观测每轮（由 `iterations.ts` emit），但 hook 返回 `block` 不会停循环（只 log）。`emitGoalIteration` 在 `goalHook.ts` swallow 任何异常。
- `<goal-not-achieved/>${reasons.join('; ')}` user message 是 chovy-code 私有的注入约定（cc-haha 用 `<goal-objective>` 注入 + Stop hook 拦截，chovy-code 直接在 messages 数组里追加）；后续 step 扩此 sentinel 时**追加** XML 标签，不 rename。

**取消传播不变量（goal-loop）**：
- 路由器**本地 AbortController** 包装外部 `opts.abortSignal`（§9 红线代码化）；budget 超限 / 死循环兜底都 `ac.abort()`，不污染调用方 signal。
- `ac.signal` 传给 `engine.run({abortSignal: ac.signal})`（engine 内部再包一层 AC，双层隔离）。**绝不**把 `opts.abortSignal` 直接传 engine。
- REPL 的 `goalAcRef` 同样是本地 AC，Esc / `/goal pause` / Ctrl+C × 2 都通过这个 ref 触发。

**rubric judge 不变量**：
- 默认走父 provider 的小模型（`smallModelFor` 表，`convergence.ts`），不复用 `swarm/judge.ts` 的长上下文 fallback 链（用途不同：judge 要长 ctx，rubric 要小快）。如需让 rubric 走长 ctx fallback，**新加** `judge.ts` export，**不**改 `smallModelFor`（避免漂移，与 PCM 单源同模式）。
- rubric 调用 `provider.complete({...signal: opts.abortSignal})`；命中 AbortError → `ok:false / reason:'cancelled'`，**不**抛。
- `tryFixJSON` 五步修复（去 ``` / 截首尾 prose / 补缺括号）从 `swarm/judge.ts` import；**不**重实现（单源）。

**command rubric 不变量**：
- `bashTool.run({command, timeoutMs:120_000}, ctx)` 路径走合成 `ToolContext`（cwd / abortSignal / no-op hookEngine / `permissions.preflight=()=>allow` / `config: loadConfig()`）；`config` 字段必须填（ToolContext 冻结字段）。
- 跳过 L2-L6 权限层是**故意的**：用户显式通过 `--cmd` 设置 rubric。`bashTool` 内部的 `evaluateDanger` 在 `run()` 顶部仍会再跑（§16 L1g safety check 同源）—— `rm -rf /` / `--no-verify` / `git push --force` 等 §5 红线仍然 hard-deny。
- `result.structuredOutput.kind==='completed' && exitCode===expectedExitCode` 是收敛判据；其它 kind（`denied` / `backgrounded`）→ `ok:false`。

**死循环兜底不变量**：
- `noProgressRounds` 计数器：每轮 `roundMutatedFiles(result)` 启发式扫描 `result.messages` 中是否有 fs-mutate tool message（`toolName === 'file_write'/'file_edit'` 或 `bash` 输出含 `classes=...WRITE`），无则 `noProgressRounds++`，有则归零。
- 连续 `NO_PROGRESS_LIMIT=5` 轮无进展 → `status='paused'` + 警告日志。用户可 `/goal resume` 继续（明知风险）。
- 启发式偏保守（漏报方向是"提早 pause"），符合"防卡死"目标；step-26 真实 checkpoint 落地后可改成"无文件 hash 变化"——更准但 cost 高。

**持久化不变量**：
- 所有 `safeFs.write` 调用包 try/catch + warn，磁盘异常不让循环崩溃（in-memory 仍可用）。
- `loadGoal` **不**覆盖已存在的 in-memory entry（`goalsByThread.has(threadId)` 检查）—— 一个活跃 goal 引用比磁盘副本更权威（in-memory entry 是被 mutate 的；persistGoal 写它最新）。
- 持久化 schema **不**版本化；扩展字段 MUST 可选（向后兼容老 JSON 文件）。

**checkpoint 协作不变量**：
- `triggerCheckpoint` detached（`void ctx.spawnFn(...)` 不 await）；checkpoint 写入失败**永不**让 goal 循环失败（§17 onToken/onToolStart/onUsage best-effort 同模式延伸）。
- `shouldCheckpoint(goal) === goal.rounds > 0 && goal.rounds % CHECKPOINT_INTERVAL_ROUNDS === 0`（默认 `CHECKPOINT_INTERVAL_ROUNDS=5`）。
- step-26 落地真实 checkpoint 模板时 **替换** `triggerCheckpoint` 内的 prompt 文本 + 路径沙箱接入；spawn API 不变（继续走 step-19 既有 `pool.spawn({role:"checkpoint-writer"})`）。

**REPL UI 不变量（step-23 GoalPanel）**：
- GoalPanel 仅在 `goalState !== null && !CHOVY_NO_SWARM_PANEL` 时挂载；`CHOVY_NO_SWARM_PANEL=1` 同时禁用 SwarmPanel + GoalPanel（Windows ConHost 闪烁缓解，§Phase E 不变量延伸）。
- 3-way Tab 焦点环 `"input" → "swarm" → "goal" → "input"`，**仅可见**面板参与（运行时 ring 重建）。busy 时不切焦点（保持 §Phase E 不变量）。后续步骤新加面板（step-29 SkillPanel）请扩展同一 ring 而非新建 hotkey。
- `ReplGoalRuntime` 由 REPL 闭合 provider/model/mode 注入；`cli/slashCommands/goal.ts` 不 import `runGoal` / `QueryEngine`（保持 UI-only 边界）。

**headless 退出码不变量**：
- `chovy goal "..."` 退出码：`0` = `achieved`、`1` = `failed`/`cancelled`、`2` = `paused`。CI 可用。
- SIGINT → `ac.abort()`；headless 进程响应一次 `process.once('SIGINT', ...)`，不重复绑定（避免双重退出语义）。

**依赖图无环**：
- `src/goals/*` import `engine/index` (QueryEngine) + `swarm/judge.tryFixJSON` + `tools/exec/bash.bashTool` + `harness/hooks/index.createHookEngine` + `agent` (SpawnFn type only)；**不**反向被 engine / providers / harness 依赖（goals 是叶子）。
- `src/cli/repl.tsx` import `goals/index` 全套；`cli/slashCommands/goal.ts` 仅 import `goals/index` + 类型，**不**触 engine/providers（保持 UI-only）。
- `src/cli/index.tsx` 通过动态 `import("./goalHeadless.js")` 加载头less runner，避免主 CLI bundle 把 `src/goals/` 都拉进来（lazy load）。

## 20. Phase G 不变量（Memory Store — TMT 第一步）

> Phase G step-24 产物/验收见 `docs/complete/step-24-acceptance.md`。本节固化 step-24 跨步骤生效的不变量；后续 step-25（注入）/ step-26（checkpoint-writer）/ step-27-28（SCW）扩展对应模块时必须遵守。

**单源规约**（接 §16/§17/§18/§19 同模式）：
- `MemoryLayer` / `MemoryType` / `MemoryRecord` / `MemoryQuery` / `MEMORY_LAYERS` / `MEMORY_TYPES` → `src/types/memory.ts`（step-24 B4 屏障冻结）；`src/memory/types.ts` 仅 re-export。后续 step-25/26 用 `import type` 复用，**禁止**重声明 union。
- DDL 单源 = `src/memory/migrations.ts` 的 `MIGRATIONS_SQL` 字符串常量；**不**维护独立 `migrations.sql` 文件（避免 build.ts 拷贝资源 + bundle 路径解析的次生问题）。schema 变更必带新 migration step + bumpVersion；旧版本不删除（向后兼容老 .db）。
- `memory.index` telemetry 单源 = `src/memory/store.ts:rebuild` + `createMemoryStore` 的 `init` + `syncFromFiles.ts:syncProject`；CLI / 上层模块**禁止**直接发射。`memory.injection` 留给 step-25（不在本步发）。
- 文件 I/O 单源 = `safeFs`（不直接 `node:fs`），与 §9 红线一致；`mkdirp` / 原子 write 都走 safeFs。
- size limits 单源 = 文件常量：`MAX_MEMORY_LINES=200` / `MAX_MEMORY_BYTES=25_000`（cc-haha 对齐）；`MAX_NOTES_LINES=500` / `MAX_NOTES_BYTES=64_000`；`PROGRESS_TAIL_BYTES=32_000`。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `MemoryRecord` / `MemoryQuery`（step-24 B4 冻结）：扩展**追加**字段；不改既有。`tags` 字段是非可选 `string[]`（默认 `[]`）—— 调用方可直接 `record.tags.includes(...)` 不必空守。`score` 是 runtime-only 字段（FTS 排序后填充），**永不**持久化。
- `MemoryStore` 接口（step-24 §API 冻结）：`upsert` / `upsertMany` / `remove` / `removeBySource` / `list` / `search` / `rebuild` / `count` / `getIndexedMtime` / `setIndexedMtime` / `close`；扩展**追加**方法不替换签名。`degraded` / `path` / `projectId` 是只读属性，调用方用于 telemetry / UI 显示。

**`bun:sqlite` 降级路径不变量**：
- 探测一次（`cachedCtor: BunDatabaseCtor | null | undefined` 缓存），未探 = `undefined`、不可用 = `null`、可用 = 构造器；`_resetSqliteProbeForTesting` / `_forceInMemoryForTesting` 两个测试钩子不要在生产路径调用。
- 缺失 → `InMemoryStore` + `logger.warn` + `memory.index { degraded: true, op: "init" }` telemetry；**不**抛 `CONFIG_INVALID`。让 step-25/26 注入路径仍能工作（最坏 = 空注入 + warn）。
- InMemoryStore 的相关性分数 = `importance + countOccurrences * 5`（不是 BM25，但仍提供稳定 ranking 信号）；FTS 退化为 `content/tags.toLowerCase().includes(needle)`。

**migrations 执行不变量**：
- 用 `db.exec(MIGRATIONS_SQL)` **整块**执行 multi-statement DDL，**不**调 `splitStatements()` 逐句 exec。原因：FTS5 trigger 的 `BEGIN ... INSERT ... ; END;` 体内嵌入 `;`，朴素分割会破坏触发器创建（早期实现踩过这坑，全 case 静默降级到 InMemoryStore 才被发现）。`splitStatements` 仍作为公共 helper 导出（外部脚本可能要逐句执行）但主路径不用。
- 每个 statement 用 `IF NOT EXISTS`，迁移再跑安全。schema_version 表用 `INSERT OR IGNORE` 写初值。

**deterministic id 不变量**：
- `mem_<sha1(projectId|sourcePath|sourceLine|content)[:12]>`（`store.normalizeRecord` → `generateId` 自动派发）。`upsert` 调用方传空 `id` 即触发派发；同一 bullet re-parse 产生同 id → upsert 而非重复入库（idempotent sync）。
- `sourcePath` / `content` 为空（来自非文件源）→ 兜底 `mem_<random[12]>`，调用方需自管 id 唯一性。

**rebuild / sync 不变量**：
- `rebuild('')` 必须抛 `MEMORY_INDEX_CORRUPT`（防 SQL `WHERE project_id = ''` 误删全表）。
- `rebuild(projectId, repopulate)` 用 `db.transaction()` 包 `DELETE_PROJECT_SQL` + `DELETE_PROJECT_META_SQL` + `repopulate` 内的所有 INSERT；`repopulate` 是 caller-side I/O（`syncFromFiles.forceRebuild` 在事务**外**读文件 + 在事务内 collect → 灌库）—— 让长 I/O 不锁数据库。
- `mtime` 缓存：`memory_index_meta(project_id, source_path)` PK；`syncProject` 命中（`stat.mtime <= cached`）跳过整个文件；不命中 → `removeBySource` + 重 parse + `upsertMany` + `setIndexedMtime`。`forceRebuild` 路径会清掉 `memory_index_meta`，事务后再用 stat 把所有 mtime 重新写回。
- 单源失败（一个文件 parse 异常）→ warn + skip + 继续；**不**让一个坏文件阻塞项目级 sync。

**FTS5 / ranker 不变量**：
- tokenizer = `unicode61 remove_diacritics 2`（中文分词差但够用；spec §risks 提示后续可换 trigram，本步不做）。
- `sanitizeFtsQuery` 把用户文本切 token + 引号包裹，避免 `MATCH` 解析错误（防 `:`、`*`、运算符注入）。
- ranker 默认根据 `query.text` 是否存在切：有 text → 默认 `bm25`；无 text → 按 `importance DESC, updated_at DESC`（`ranker` 字段被忽略）。
- mixed ranker 公式 = `0.7 * (-bm25(memories_fts)) + 0.3 * exp(-(now - updated_at) / 30d)`；`exp()` 在某些 sqlite 版本可能缺 → catch + fallback 到纯 BM25 + debug log（实际未触发，Bun 1.1+ 自带 math 扩展）。
- `clampLimit`：默认 50，硬上限 1000；`<= 0` / NaN → 50；防 caller `limit:Infinity` 触发全表扫描。

**`memory/*` → 叶子模块**：
- 可被 `cli/index.tsx`（动态 import 实现 lazy load）+ 后续 step-25 `injection.ts` + step-26 checkpoint-writer + step-27/28 SCW 引用；
- **不**反向 import `engine` / `providers` / `agent` / `swarm` / `goals`；
- 与 §17 `engine→providers` 边、§18 `swarm/pool → agent/pool` 边同模式 —— 保持 DAG。
- `src/index.ts` 加 `export * as memory from "./memory/index.js"` 后，外部消费方走命名空间 `memory.createMemoryStore(...)`，避免 barrel 被工具 / 类型污染。

## 21. Phase G 不变量（Checkpoint Writer — TMT 第二步）

> Phase G step-26 产物/验收见 `docs/complete/step-26-acceptance.md`。本节固化 step-26 跨步骤生效的不变量；后续 step-27/28（SCW）/ step-30（端到端）扩展对应模块时必须遵守。

**单源规约**（接 §16/§17/§18/§19/§20 同模式）：
- `ToolContext.agentRole?: AgentRole` → `src/types/tool.ts`（step-26 新增，§16 frozen-extension：纯可选，缺省视作 `"main"`，工具层做 role-aware 行为时**必须 opt-in** —— 只在 role 显式匹配时收紧，不在缺省时收紧）。
- `checkpoint.written` telemetry 单源 = `src/memory/checkpointWriter.ts:maybeCheckpoint`；CLI / goal-loop / SCW **不**直接发此事件（与 §17 `agent.cost`、§20 `memory.index` 同模式）。
- `CheckpointWritten` hook event 仍在 step-13 冻结的 12 事件 union 内（**不**扩 union）；advisory —— emit 失败 swallow，不影响 latest.md 已写盘。
- 路径沙箱**仅在工具层**（`src/tools/fs/write.ts` + `src/tools/fs/edit.ts`），**永不在** prompt 文本里声明安全边界（AGENTS.md §16 "prompt 不是 security boundary"）。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `CheckpointCoordinator.maybeCheckpoint(reason, input)` / `CheckpointResult` / `CheckpointInput` / `CheckpointReason`（step-26 冻结，B6 屏障预留）：扩展**追加**字段；不改既有签名。reason 联合（`goal-round` / `manual` / `session-end` / `token-soft` / `big-event`）扩展只新增成员，不替换既有。
- `ReplCheckpointRuntime`（step-26 追加到 `ReplCtx.checkpoint`，§16 兼容）：`triggerNow()` + `list()`；UI-only，不 leak provider/queryEngine/coordinator 引用（与 §19 `ReplGoalRuntime` 同模式）。

**路径沙箱不变量**：
- `agentRole === "checkpoint-writer"` 时 `file_write` / `file_edit` 校验 `path` 必须落在 `checkpointDir(ctx.cwd)` 内；越界 → `TOOL_DENIED`。
- 同时把 `checkpointDir(cwd)` 加入 `assertWritable.allowOutsideCwd`（checkpoint dir 在 `~/.chovy/projects/<hash>/` 下，物理上在 cwd 之外 —— 不加 allowlift 会被 §16 L1g 物理沙箱拒绝）。**黑名单仍生效**：`~/.gitconfig` / `.ssh` / `.chovy/secrets` 等仍 hard-deny（防御纵深）。
- 协调器写盘前做 `isWithin(dir, latest) && isWithin(dir, archive)` paranoia 校验（路径由协调器自身计算，正常不越界，但 cheap to keep honest）。

**协调器不变量**：
- **防抖 30s / per-reason**（`DEBOUNCE_WINDOW_MS = 30_000`）：同 reason 在窗口内第二次调用 → `{ ok:false, reason:"debounced" }`；不同 reason 互不抑制（manual + goal-round + token-soft 可同时触发）。防抖 map 进程内单例，`_resetCheckpointCoordinatorForTesting` 清空。
- **轮转上限 50**（`MAX_ARCHIVE_FILES = 50`）：每次写盘后 `rotateArchive(cwd, 50)`，按 `mtimeMs` 降序保留前 N，余 `safeFs.remove`（remove 本身限制在 `~/.chovy` 内）；`latest.md` 不参与计数（永不轮转）。
- **fallback 路径**：spawn 失败 / 超时 / 取消 / 输出空 body → `mode:"fallback"`，coordinator 用 `buildFallbackMarkdown` 写 7 段规则化模板（与 agent 输出同 schema，下游 SCW 解析无特例）。
- **取消协议**（§9 红线代码化）：协调器本地 `new AbortController()` 包装 caller `parentSignal`；三层包装 `caller signal → coordinator AC → pool child AC → engine AC`，**绝不共享 signal 对象**。pre-aborted caller signal → 走 fallback，不抛。
- **失败不致命**：所有 fs 异常 / hook emit 异常 / rotate 异常都 `try/catch + logger.warn`，coordinator 返回 `{ ok:false, error }` 而不抛给 caller（spec §性能："失败时 telemetry warn，不打断主流程"）。

**调用契约**：
- caller 用 `void coordinator.maybeCheckpoint(...)` fire-and-forget（goal-loop / REPL slash 都这么调）。coordinator 内部 `await pool.spawn({ background: false })`，但调用方不 await。
- `triggerCheckpoint(goal, ctx)` 公共签名 step-23 冻结；step-26 只改实现（委托 coordinator），签名不变。`ctx.spawnFn` 保留作 backward-compat 但**忽略**（coordinator 自取 `getSubAgentPool()`）。

**spawn 配置不变量**：
- `role: "checkpoint-writer"`（step-19 冻结）；
- `shareSession: false`（不再注入父 snapshot，避免循环；协调器已在 prompt 里塞了 historyTail + recentMessages）；
- `background: false`（协调器要 await 结果决定 fallback / 写盘 / hook）；
- `budgetUSD: 0.05` / `timeoutMs: 30_000` / `maxRounds: 4`（与 step-19 角色定义一致）。

**子 agent 模板不变量**：
- 7 段 markdown：`# Checkpoint <ISO>` / `## Goal` / `## Done in this session` / `## In Progress` / `## Decisions` / `## Files touched` / `## Open questions / Risks` / `## Next intended steps`。下游 SCW（step-27/28）按此 schema 解析。
- ≤ 8 KB（`MAX_CHECKPOINT_BYTES = 8 * 1024`）；oversized → `truncateBody` 保留头尾各 ~3.5 KB + `[truncated …]` 标记。
- agent 在 `file_write` 之后**也**把 markdown body 作为最终 assistant 消息输出（coordinator 用作 fallback 源）。

**`subagent_type` enum 仍不含 checkpoint-writer**：`tools/meta/agent.ts` zod enum 只列 Explore/Plan/Verify/Critic；checkpoint-writer 由 coordinator / SCW 直接 `pool.spawn({ role: "checkpoint-writer" })` 调用，不暴露给主 agent（与 §18 step-19 不变量一致）。

**依赖图无环**：
- `src/memory/checkpointWriter.ts` import `agent/pool` (`getSubAgentPool` + 类型，**leaf reach**，不经 `agent/index` barrel —— barrel 重导出 `runAgent` 顶层 `setSpawnFnBuilder(...)` 会闭环 engine→memory→agent→engine 触发 TDZ on registry，与 §18 `swarm/pool → agent/pool` 同模式) + `fs`（`safeFs` / `checkpointDir` / `isWithin`）+ `harness/hooks`（类型）+ `telemetry`（emit）+ `types/agent`；**不**反向被 engine / providers / harness / goals 依赖。
- `src/goals/checkpoint.ts` → `memory/checkpointWriter`（新增依赖，单向）；`goals/iterations.ts` → `goals/checkpoint.ts`（既有）。goals 仍是叶子。
- `src/cli/slashCommands/checkpoint.ts` → 仅 `slashCommands` 类型（UI-only，与 `cli/slashCommands/goal.ts` 同模式）；`src/cli/repl.tsx` → `memory/checkpointWriter`（通过 `checkpointRuntime` 闭包注入，类似 `goalRuntime`）。
- `src/tools/fs/write.ts` / `edit.ts` → `fs`（既有，新增 `checkpointDir` / `isWithin` import）+ 读 `ctx.agentRole`（types/tool.ts）；**不**引入新模块依赖。

**token-soft / big-event 触发延迟到 SCW**：
- coordinator 已接受 `'token-soft'` / `'big-event'` reason 入口；但实际触发判定（contextBudget > soft 阈值 / dispatch 完成 / 长 bash 完成）由 step-27/28 SCW 接通。本步**不**在 QueryEngine 内嵌触发点（避免 §17 queryEngine.ts ≤ 600 行硬限被破坏 + 避免 SCW 未落地前误触发）。

**checkpoint → MemoryStore bridge（Phase G 复验 G1 闭合）**：
- coordinator 写出的 `checkpoints/*.md` 经 step-24 `syncFromFiles.collectSourceFiles` 当 `layer=checkpoint` 源文件解析 + upsert 落 MemoryStore —— **file-primary sync 路径已落地索引**，coordinator **不**需要在写盘后再做一次 direct `upsertFromCheckpointFile`（文件是主源、store 是派生索引，step-24 §文件 ↔ DB 同步）。coordinator 中保留的 `NOTE` 注释指 direct-call 仅是省一次 mtime 探测的微优化，非功能缺口。
- **bridge 必须有 smoke 覆盖**：`scripts/smoke-step26.ts §13`（coordinator 写 latest.md → `syncProject` → FTS search 命中 + `layer==='checkpoint'`）。后续改 `syncFromFiles.collectSourceFiles` 的 checkpoint 分支或 `parser` 的 checkpoint 路径时，该 smoke 是回归门，**不得删除或弱化**。

## 22. Phase H 不变量（Context Monitor — SCW 第一步）

> Phase H step-27 产物/验收见 `docs/complete/step-27-acceptance.md`。本节固化 step-27 跨步骤生效的不变量；后续 step-28（rebuild）/ step-29（CSG）扩展对应模块时必须遵守。

**单源规约**（接 §16/§17/§18/§19/§20/§21 同模式）：
- `ContextLevel` / `MonitorState` / `ContextThresholds` → `src/context/monitor.ts` + `src/context/thresholds.ts`（step-27 冻结，B6 屏障预留）；`src/context/index.ts` 仅 re-export。后续 step-28/29 用 `import type` 复用，**禁止**重声明 union。
- `ContextPressure` → `src/types/context.ts`（step-27 冻结）；`src/prompts/snippets.ts:PressureSnippet` 是 prompt 渲染入参的别名（结构相同），不重声明 union。
- **PCM 单源**：`thresholds(model, providerId, cfg, env)` 直接读 `CAPS[providerId].contextWindow`（step-17 PCM 单源，AGENTS.md §17）。新增 provider 的 ctx window 在 `src/providers/capabilities.ts` 一处声明即可，monitor 自动 pick。
- **`context.threshold` telemetry 单源** = `src/context/monitor.ts:emitTelemetry`（在 `inspect()` 内的 transition 分支）。queryEngine / coordinator / REPL / HeaderBar 全部为消费方，**不**直发；与 §17 `tool.call`、§17 `agent.cost`、§18 `swarm.dispatch`、§20 `memory.index`、§21 `checkpoint.written` 同模式。
- **token estimator 单源** = `src/context/tokenizer.ts:defaultEstimator`；后续 tiktoken-light / Anthropic count-tokens API 必须经 `pickEstimator(family)` 注册，**不**另写并行实现。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `MonitorState`（step-27 冻结，B6 预留）：6 字段（`total / effective / thresholds / level / transitioned / checkpointTriggered`）；扩展**追加**字段不替换既有。
- `ContextThresholds`（step-27 冻结）：5 字段（`ctxWindow / soft / hard / reserve / effectiveWindow`）；`effectiveWindow = ctxWindow - reserve` 派生且 reserve clipped at 50% ctxWindow。
- `ContextMonitor` 接口（step-27 冻结）：`thresholds` (readonly) / `level` (readonly) / `inspect(messages, systemBytes)` / `onLevelChange(cb)` / `_resetForTesting()`；扩展**追加**方法不替换签名。
- `QueryRunOptions.onContextSnapshot?` / `AgentOptions.onContextSnapshot?` / `AgentOptions.onUsage?`（step-27 追加，§16 frozen-extension）：UI 回调 best-effort，异常 swallow + warn，**绝不**让运行失败（与 §18 `onToken/onToolStart/onUsage` 回调 best-effort 同模式）。
- `BudgetSnapshot.pressureLevel?`（step-27 追加，UI-only）：HeaderBar 着色用，仅 `'fresh'|'soft'|'hard'`；其它字段不动。
- `SystemContext.pressure?: PressureSnippet`（step-27 追加，prompt builders 冻结字段）：仅在 dynamic 半区，**不**影响 `staticHash`（boundary 不变）。

**上转换 sticky max-level 不变量**：
- `isUpwardTransition(prev, next)` 用 `{fresh:0, soft:1, hard:2}` 数值序判定。下转换（hard→soft / soft→fresh）**不**触发 telemetry / checkpoint，避免临时消息裁剪导致 soft 反复 fire。
- step-28 rebuild 后由 monitor 重置（`_resetForTesting()`）或 queryEngine 新建实例处理 level 回退，step-27 不主动降级。

**取消独立 AC（AGENTS.md §9 代码化）**：
- monitor 持 `parentSignal` 仅 *观察*；从不直接 forward 给 coordinator 的 spawn signal。
- `maybeCheckpoint` 触发用 fire-and-forget `void coord.maybeCheckpoint(...)`，coordinator 内部本地 AC 包装 parentSignal（与 §21 step-26 §11 不变量一致）。
- pre-aborted parentSignal → `inspect()` 同步返回 state，**不抛**；checkpoint 触发由 coordinator 自身处理 abort 短路。

**checkpoint 触发不变量**：
- 上转换 fresh→soft 与 soft→hard 都用 reason `'token-soft'`（step-26 union 当前不含 `'token-hard'`）；coordinator 30s per-reason debounce 自然兜底快速 soft→hard 翻转。
- 单次 `inspect()` 至多触发一次 checkpoint（与 telemetry emit 数量一致）；`MonitorState.checkpointTriggered` 反映本次 *尝试*，coordinator 实际是否写盘由它自己的 debounce + 写失败兜底决定。

**`CHOVY_CTX_DISABLE=1` 退化路径**：
- `createContextMonitorIfEnabled(deps)` 检查 env，返回 `null`；queryEngine 主循环 `if (ctxMonitor) { ... }` 守卫。无 monitor 时不发 telemetry / 不触发 checkpoint / 不注入 pressure 段，但 engine 主循环正常继续；`<Context budget>` 段在 `pendingBudget=undefined` 时也不渲染。
- 与 `CHOVY_NO_SWARM_PANEL=1` 同模式（运行时切换，纯 process.env 读，不进 ChovyConfig schema）。

**hard 不在 step-27 自我 rebuild**：
- spec 写 hard → "进入 step-28 的 rebuild 流程"。本步 monitor 在 hard 时仅做：emit telemetry + 注入更紧迫 pressure block + 触发 token-soft checkpoint + queryEngine `logger.warn` 一次。**不**主循环早退（rebuild 由 step-28 控制）+ **不**切换 reason 为 `'token-hard'`（step-26 union 当前不含；新增成员是 step-26 的事）。
- step-28 接驳点：queryEngine 在 `level==='hard'` 分支替换 `logger.warn` 为 `await rebuildContext(...)`，再 `monitor._resetForTesting()` / 新建 monitor，使 level 回到 fresh。

**queryEngine.ts ≤ 600 行（硬限）**：
- step-27 落地时为 600 行（恰至硬限；当前复验值见 §24/§25）。SCW 适配独立到 `src/engine/contextHook.ts`（108 行：`createContextMonitorIfEnabled` / `pendingFromMonitorState` / `notifyContextSnapshot`），spawn/dispatch handle 构造独立到 `runHelpers.ts:buildSpawnHandles`。
- 后续 step-28 rebuild 接入时**不要**把逻辑塞回 queryEngine.ts；继续抽 helper（rebuild 候选 → `engine/rebuildHook.ts`）或扩展 `contextHook.ts`。

**依赖图无环**：
- `src/context/*` 是叶子模块：可被 `src/engine/queryEngine.ts` / `src/engine/contextHook.ts` / 未来 `step-28 rebuilder` / `step-29 SCG` 引用，**不**反向 import `engine` / `providers` / `agent` / `swarm` / `goals`（与 §20 memory 同模式）。
- `src/engine/contextHook.ts` import `src/context/index` + `src/prompts/index` 类型；queryEngine 只通过此模块接 monitor，避免 import 链膨胀。
- **engine→memory→agent→engine 加载环已闭合**：step-27 把 `src/memory/checkpointWriter.ts` 的 `getSubAgentPool` import 从 `agent/index`（barrel）改到 `agent/pool`（leaf），切断 barrel 触发的 `runAgent.ts` 顶层 `setSpawnFnBuilder(...)` 在 registry 仍处 TDZ 时被调用的 race。这是与 §18 `swarm/pool → agent/pool` 同模式的 leaf-reach 纪律，**不得**回退。

**`ContextBudget` 类型留 step-28**：
- `src/types/context.ts` 已冻结 `ContextBudget`（5 bucket：memory/checkpoint/notes/skills/tail）；step-27 仅消费 `ContextBudgetSnippet`（render-only 子集，2 字段 used/total）。step-28 rebuilder 用 `ContextBudget` 做预算化裁剪，本步不实现。

**`MIN_SOFT_RATIO = 0.5` 防御性下限**：
- thresholds.ts 拒绝 `softRatio < 0.5` / `softRatio >= hardRatio` / `hardRatio > 0.99`，回退 cfg 默认 + warn。防 user 把 ratio 设成 `0.05` 之类导致每轮都 fire soft。如未来出现合法低 ratio 用例，可放宽下限到 0.1 或加 `CHOVY_CTX_ALLOW_LOW_RATIO=1` 后门，**不要**直接删除该下限。

## 23. Phase H 不变量（Context Rebuild — SCW 第二步）

> Phase H step-28 产物/验收见 `docs/complete/step-28-acceptance.md`。本节固化 step-28 跨步骤生效的不变量；后续 step-25（Memory Injection 与本步 selector 共用）/ step-29（CSG 占用 skills 桶）/ step-30（端到端集成）扩展对应模块时必须遵守。

**单源规约**（接 §16/§17/§18/§19/§20/§21/§22 同模式）：
- `ContextBudget` → `src/types/context.ts`（step-28 B6 屏障冻结）；8 桶（`systemBase / memory / checkpoint / notes / taskProgress / skills / tools / history`）+ `tail` 别名（已 deprecate，仅给 step-27 占位消费方使用）。后续 step-29/30 用 `import type` 复用，**禁止**重声明字段。
- `RebuildContextInput / RebuildContextResult` → `src/context/rebuilder.ts`（step-28 冻结）。`src/engine/rebuildHook.ts` 通过 `import type` 透传，不重声明。
- **`context.rebuild` telemetry 单源** = `src/context/rebuilder.ts:rebuildContext`；CLI / engine / monitor / coordinator 全部为消费方，**不**直发；与 §17 `tool.call`、§17 `agent.cost`、§18 `swarm.dispatch`、§20 `memory.index`、§21 `checkpoint.written`、§22 `context.threshold` 同模式。`context.threshold` 与 `context.rebuild` 是**两个**事件类型 —— monitor 仍是 `context.threshold` 唯一发射点（§22 不变量），rebuilder 是 `context.rebuild` 唯一发射点（§23 新增）。
- **`ContextRebuilt` hook 单源** = `src/context/rebuilder.ts:rebuildContext`；advisory only（与 §21 `CheckpointWritten` 同模式）。
- **`ContextBudget` 构造单源** = `src/context/budgets.ts:computeBudget`；rebuilder 接受 `budgetOverride` 仅供测试 / SCW 调参，**不**在生产路径自手卷一个 budget object。
- **PCM 仍是 ctx window 唯一来源**：`computeBudget` 内部走 `thresholds()`（间接 `CAPS[provider].contextWindow`）。`budgets.ts` **不**直接 `import { CAPS }` —— 与 §22 同纪律（thresholds.ts 是 PCM 二级访问点）。
- **session JSONL 路径单源** = `src/fs/paths.ts:sessionFile(cwd, sessionId)`；rebuilder 是唯一对该路径执行 `safeFs.append` 的模块（写入 `# rebuild ...` header + ndjson 每消息一行）。step-30 `SessionSearchTool` 是消费方，**不**得截断 / 改写。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `ContextBudget`（step-28 B6 冻结）：8 桶字段 + `tail?` deprecated 别名；扩展**追加**字段不替换。`Object.freeze` 强制不可变 —— 调用方读不写。
- `HookEvent` union（step-13 + step-28 扩展）：`ContextRebuilt` 加入；后续步骤可继续追加成员（与 §16 frozen-extension 一致），**不**重命名既有。
- `ContextMonitor.reset()`（step-28 新增）：清 `_level → fresh`，**保留** listeners（区别于 `_resetForTesting()` 同时清两者）。仅 SCW rebuild 路径调用；UI / CLI **不**调用。
- `CostTracker.cumulativeTotal()` / `splitSession()`（step-28 新增）：`cumulative` 字段 record() 累加、`splitSession()` **不**清；budget 闸（`cost.cumulativeTotal().usd >= budgetUSD`）继续用 cumulative —— rebuild **不可**绕过 budget。`reset()` 同时清 `totals` + `cumulative`（`run()` 复用 instance 的 corner case）。
- `ScwRoundOutcome` / `MaybeRebuildOutcome`（step-28 冻结，B6 预留）：扩展**追加**字段不替换既有。

**取消传播不变量（rebuild）**：
- rebuilder 的 `parentSignal` 仅 *观察*；selectors 今天都是同步 fs read / sqlite 查询，无独立 AC。后续若加网络 selector（如 `searchExternal`），按 §9 红线**必须**本地 AC 包装 parentSignal —— 不直接转发。
- `runScwRound` → `maybeRebuild` 链路无新增 AC，复用 caller signal（与 step-21 judge 取消独立 AC 同纪律差异：rebuild 无 spawn，无需独立 AC）。

**budget 防绕过不变量（step-28 关键）**：
- `cost.splitSession()` **只**清 session 计数 + byModel；`cumulative` 永不清。
- queryEngine.ts budget 闸（`run()` 主循环顶部）**必须**用 `cumulativeTotal().usd` —— 不能回退到 `total().usd`，否则 rebuild 后 budget 重置为 0，用户可借多次 rebuild 无限刷预算。本不变量等同于：**SCW rebuild ≠ budget 重置**。
- `agent.end` telemetry 的 `costUSD` 字段 + `QueryRunResult.costUSD` 字段统一用 cumulative —— 用户看到的"本次 run 总花费"包含 rebuild 前后所有 round。

**`recentMessagesPick` 不变量**：
- `tool_use ↔ tool_result` 配对保护（spec §风险）：`pruneOrphans` 后 `pruneIncompleteTrailingAssistant`；
  - 孤立 tool message（前面无 assistant.toolCalls）→ 丢；
  - 尾部 assistant.toolCalls + 无后续 tool result → 丢整条。
- 严格 budget 裁剪：超 budget **不**保留（spec line 68 "按 重要性 × recency 裁剪" —— 没有 "always keep one" 兜底）。result 可能为空数组；rebuilder 的 `<context-rebuilt>` marker 仍然作为唯一系统消息保留。
- 启发式偏保守（漏报方向是"多删"，符合"防 provider 拒绝"目标）。后续 step-30 端到端发现误删时，给 ChatMessage 加 `toolCallId?: string` 才精确 —— 本步**不**加（保持 step-16 frozen surface）。

**退化路径不变量（spec §退化路径 line 105-108）**：
- `latest.md` 不存在 + memory 空 + progress 空 → marker 走 `<rule-summary>` flavor，含最后用户输入 + 可选 objective。spec 提到的"立即同步调一次 checkpoint-writer" **本步不实现**（避免 rebuild 阻塞主循环；spec §性能 + §9 red lines）—— 用户应在 step-26 落地后通过 `/checkpoint now` 主动触发。step-30 端到端可考虑接入。
- 极端：所有 selector + recent-K 都为空 → result.messages = `[<context-rebuilt with rule-summary>]` 单条。engine 主循环继续 —— provider 看到的是干净的 system 标记，可以重新理解任务。

**queryEngine.ts ≤ 600 行（硬限）守恒**：
- step-28 落地时为 598 行（恰至硬限 - 2；当前复验值见 §24/§25）。step-28 通过：① 把 SCW 块（11 行）替换为 `runScwRound` 单调用（21 行 → 净 +10）；② 抽 SCW glue 到 `engine/rebuildHook.ts:runScwRound`（同 §17 / §22 contextHook.ts 模式）；③ 合并多行 import → 单行。
- 后续 step-29/30 接入时**不要**把逻辑塞回 queryEngine.ts；继续抽 helper（CSG candidate → `engine/skillHook.ts`）或扩展 `rebuildHook.ts` / `contextHook.ts`。

**依赖图无环**：
- `src/context/rebuilder.ts` → `src/memory/store.ts`（leaf-reach createMemoryStore）+ `src/fs/safeFs` + `src/fs/paths` + `src/types/*` + `src/context/{budgets,tokenizer,selectors/*}`；**不**反向 import `engine` / `providers` / `agent` / `swarm` / `goals`（context 是叶子，与 §22 step-27 同模式）。
- `src/engine/rebuildHook.ts` → `src/context/rebuilder` + `src/context/index`（types）+ `src/engine/contextHook`（PendingContextHints / pendingFromMonitorState 复用）+ `src/engine/costTracker`；queryEngine.ts 通过 `runScwRound` 单点调用，避免直接 import `rebuildContext`（保持单一入口）。
- `src/context/selectors/memoryPick.ts` → `src/memory/store.ts`（leaf-reach `createMemoryStore`）；**不**经 `memory/index` barrel —— barrel 重导出 `CheckpointCoordinator` 等，会无谓拉入更多模块。
- `src/context/selectors/progressPick.ts` → `src/memory/files/progressFile.ts`（leaf-reach `readProgressFile`）；同上避免 barrel。

**cumulative-budget 与 §19 `RunGoalOptions.budgetUSD` 协同**：
- /goal 循环里每轮 `engine.run({budgetUSD: goal.budgetUSD - goal.totalCostUSD})`：每轮 budget 从 *剩余* 预算算起。SCW rebuild 在 round 内触发不影响 round 边界 —— `cost.cumulativeTotal()` 是 *本轮 engine.run* 的累计，不是 goal 全程。goal 循环外部加总 `goal.totalCostUSD += result.costUSD` 不变（cumulative 已包含所有 rebuild 前后的 round）。
- 后续 step-30 发现"goal budget 突然多扣"是因为 cumulative 算上了 rebuild 前的废弃消息成本时，**不要**减回去 —— rebuild 前的 round 是真的发生过的（耗费了真实 token），budget 应该承担。

**`budgetOverride` 测试入口**：
- `RebuildContextInput.budgetOverride?: ContextBudget` 仅用于 SCW smoke / 调参；生产路径**永远**走 `computeBudget()`（无内部预算硬编码）。后续 step-29 引入 dynamic skills budget 调整时，应在 `computeBudget` 内部加分支（基于 cfg.skills.maxTokens 等），**不**绕过去自手卷 budget。

## 24. Phase I 不变量（Skill Graph — CSG 创新）

> Phase I step-29 产物/验收见 `docs/complete/step-29-acceptance.md`。本节固化 step-29 跨步骤生效的不变量；后续 step-30（端到端集成）扩展对应模块时必须遵守。

**单源规约**（接 §16/§17/§18/§19/§20/§21/§22/§23 同模式）：
- `Skill` / `SkillNode` / `SkillTriggers` → `src/types/skill.ts`（step-29 B7 屏障冻结，architecture.md §3.3）；step-28 之前的 draft 字段（`id`/`description`/`match`/`body`/`approxTokens`）已替换为 spec 字段（`name`/`summary`/`triggers`/`systemFragment`/`budgetTokens` + 新增 `conflicts`），零外部 in-tree 消费方。后续 step-30 用 `import type` 复用，**禁止**重声明 union；扩展只追加可选字段（frozen-extension）。
- `skill.plan` telemetry 单源 = `src/engine/skillHook.ts:runSkillRound`；SkillTool / slash 命令 / CLI 全部为消费方，**不**直发；与 §17 `tool.call`、§17 `agent.cost`、§18 `swarm.dispatch`、§20 `memory.index`、§21 `checkpoint.written`、§22 `context.threshold`、§23 `context.rebuild` 同模式。
- **registry 单源** = `src/skills/registry.ts`；duplicate-name 抛错（与 `tools/registry.ts` 同纪律）；bundled lazy init via `ensureBundledSkillsInitialized()`（idempotent + 可被 `markBundledInitialized()` 抑制供测试用）。
- **`skills.lock` 路径单源** = `src/fs/paths.ts:skillsLockFile(cwd)` → `~/.chovy/projects/<id>/skills.lock`；`src/skills/lock.ts` 是唯一对该路径执行 `safeFs.write` / `safeFs.read` 的模块（mirror `src/goals/goalState.ts` 持久化模式）。
- **planner 单源** = `src/skills/planner.ts:plan(registry, input)`；REPL `/skill plan` dry-run、`runSkillRound` auto path 都调同一函数（避免规则漂移）。
- **prompt 注入单源** = `src/prompts/snippets.ts:skillFragmentsSection`；位于 dynamic suffix（不污染 staticHash），与 `pressureSection` / `skillsSection` 同位。

**冻结接口**（字段名不改，扩展只追加可选字段）：
- `Skill`（step-29 B7 冻结）：8 字段 `name/summary/triggers/requires?/provides?/conflicts?/systemFragment/budgetTokens`；扩展**追加**字段不替换。
- `SkillNode`（step-29 B7 冻结）：2 字段 `skill/score`；扩展追加。
- `SkillTriggers`（step-29 冻结）：3 字段 `keywords?/patterns?/when?`；`when` 联合扩展只新增成员（`'on-request'|'pre-tool'|'always'`），不替换。
- `ToolSession.activeSkillFragments?` / `ToolSession.manualSkillNames?`（step-29 追加，§16 frozen-extension）：optional 添加，旧 callers 视作 `undefined`（语义 = 空）；新 callers 必须容忍 undefined（治理性 ?? 兜底）。
- `SystemContext.skillFragments?: SkillFragmentsSnippet`（step-29 追加，§Phase D §17 frozen-extension）：仅在 dynamic 半区，**不**影响 `staticHash`。
- `QueryRunOptions.session?` / `QueryRunOptions.goalObjective?`（step-29 追加，§17 frozen-extension）：REPL 跨轮持久化 + goal-loop CSG 输入；sub-agent 不传 → 引擎构造空 session。
- `AgentOptions.session?` / `AgentOptions.goalObjective?`（step-29 追加，§Phase D §17 frozen-extension）：透传到 QueryRunOptions。

**Auto-planner 默认 OFF（least-surprise）**：
- `CHOVY_SKILLS_AUTO=1` env OR `feature('skills.auto')` 打开；二选一即触发。`CHOVY_SKILLS_AUTO=0` 显式关闭，覆盖 feature flag。
- 与 §17 `feature('auto.classifier') 默认 off` 同纪律 + AGENTS.md §5 红线 / §9 反模式：不在用户没要求时偷偷塞 ~2-4K 技能 prompt 进 ctx。
- 手动模式（SkillTool / `/skill <name>`）始终可用，无需开关。auto-off 时 `runSkillRound` 仅返回 manual entries，不调用 planner，但仍 emit 一条 `skill.plan { mode: 'manual-only' }` 供监控。

**取消传播不变量（CSG）**：
- `runSkillRound` 是同步纯计算（regex 匹配 + Map 操作 + 一次 lock IO）；不 spawn，不需独立 AC。`parentSignal` 仅用于 future 异步 selectors（step-30 LLM 评分 fallback）；今天**不**接入。
- `SkillTool.run` 同步，亦不需独立 AC。skill body 内部建议使用的工具（bash / file_edit）在它们自身的 `run` 中各自处理 abort（§9 红线）。

**fingerprint 缓存键不变量**（spec line 104-115）：
- `computeFingerprint(input, intent, _ignored)` 仅用 **inputs** 作为 key：`latestUserText + goalObjective + sortedManualNames + budgetTokens + intent.tags + intent.hasRecentToolHint`。
- 输出 `selectedNames` **不**参与 key（避免缓存循环依赖：键依赖输出会让 cache 永远 miss）。
- lock 命中时直接复用 `lock.lastSelected`，跳过 plan() — 这是 §"性能" 章节的核心优化点。
- 缓存失效条件：用户消息改变 / goal 改变 / 手动锁集合改变 / budget 改变 / 最近工具调用类型改变（intent.hasRecentToolHint）。

**closure / conflict / budget 算法不变量**：
- `computeClosure`：BFS over `requires`，inherited score = `max(0.5, parentScore - 0.1)`，访问集去重防 cycle；missing required → 报告但不抛。
- `resolveConflicts`：高分胜出，ties broken by 名字字典序（确定性）；同 conflict 组多 victim 全部 drop。
- `enforceBudget`：lowest-score 驱逐 + cascade drop（依赖被驱逐时，依赖方也被驱逐，避免悬空 require）；`capTokens ≤ 0` → 全部驱逐（degenerate 但 defined）。
- `resolveManualClosure`：与 auto closure 共享 BFS，但 missing-required 视为 FATAL 由 caller 处理；conflicts-with-active 也 FATAL；继承分数无意义（manual = 锁定）。

**queryEngine.ts ≤ 600 行（硬限）守恒**：
- 当前 585 行（2026-06-19 复验，smoke 口径；硬限 - 15）。step-29 通过：① 把 `runSkillRound` 调用抽到 `engine/skillHook.ts`（同 §17 / §22 / §23 hook.ts 模式）；② 内联多行结构 `{...}` → 单行 `{...}`；③ 不在 queryEngine.ts 内加新 import 链（computeBudget 在 skillHook.ts 内调用）。
- 后续 step-30 端到端接入时**不要**把逻辑塞回 queryEngine.ts；继续抽 helper（如 step-30 user-skill loader → `engine/skillHook.ts` 内扩展）或新建 hook 模块。

**依赖图无环**：
- `src/skills/*` 是叶子模块：可被 `src/engine/skillHook.ts` / `src/tools/meta/skill.ts` / `src/cli/slashCommands/skill.ts` / `src/cli/repl.tsx` / `src/cli/index.tsx` / `scripts/smoke-step29.ts` 引用，**不**反向 import `engine` / `providers` / `agent` / `swarm` / `goals` / `memory` / `context`（与 §22/§23 同模式）。
- `src/engine/skillHook.ts` import `src/skills/index` + `src/context/budgets` + `src/types/*` + `src/config/*` + `src/logger` + `src/telemetry` + `src/prompts` (types only)；queryEngine.ts 通过 `runSkillRound` 单点调用，避免直接 import `plan / extractIntent` 散落。
- `src/cli/repl.tsx` import `src/skills/index` 是 **UI-only** 边界（slash runtime + dry-run 都在 REPL 内执行，不进 engine）；与 §19 `goalRuntime` / §21 `checkpointRuntime` 同模式。
- `src/tools/meta/skill.ts` reach `src/skills/index` 是 leaf-reach（registry / graph / closure 都在 leaf）；不经过 engine barrel 避免任何成环可能。

**skill body / fragment 体积上限**：
- `src/prompts/snippets.ts:SKILL_FRAGMENT_BODY_CAP = 8000` 字符（≈2k token）每片段硬截断 — 防御一个误配置 skill 把 prompt 撑爆。
- 整体 skill 预算由 `ContextBudget.skills` 决定（默认 8000 tokens；`src/context/budgets.ts:DEFAULT_SLABS.skills`）—— planner 在选择阶段就强制总和 ≤ 该值。两层守门（per-fragment cap 是兜底，per-budget cap 是策略）。

**用户自定义 skill 留 step-30**：
- 当前 7 bundled skills (`commit/format/pr/refactor/review/test/ts-fix`) 满足 spec 验收。
- step-30 端到端集成将加 `~/.chovy/skills/<name>/SKILL.md` frontmatter 解析 + `loadSkillsDir(path)` API；接入点：`registry.ensureBundledSkillsInitialized` 之后追加 `loadUserSkills(chovyHome())` 调用即可（registry duplicate-name 抛错就近暴露冲突）。
- 不向 `Skill` 类型加新字段 — 用户 frontmatter 应映射到既有字段（`name` / `summary` / `triggers.keywords` / `requires` / `provides` / `conflicts` / 内联 markdown body 作 `systemFragment`）。

**与 spec 偏离的两处**（`docs/complete/step-29-acceptance.md §5` 详）：
1. Skill 类型字段名对齐 spec（drop 草稿别名）—— 草稿零 in-tree 消费方，spec 是 docs/ 权威。
2. prompt 注入用 dynamic suffix（不用 default-layer append）—— 保 PSF staticHash 跨轮稳定，与 step-15 §15 不变量对齐。
两处均与用户在 plan 阶段确认。

## 25. Phase I 不变量（Integration / E2E — step-30）

> Phase I step-30 产物/验收见 `docs/complete/step-30-acceptance.md`。本节固化端到端验收入口，尤其是 Windows 复验发现的 demo 跨平台问题。

**跨平台 demo 不变量**：
- `bun run demo` 是端到端 demo 的正式验收入口；必须在 Windows/Unix 都可运行。
- `scripts/demo.ts` 是 demo 单源实现，使用 Bun spawn + regex 断言，不依赖 Bash、`grep`、WSL、真实 provider 或用户真实 `~/.chovy`。
- `scripts/demo.sh` 只作为 POSIX wrapper，内部委托 `bun run demo`；后续不要把业务断言重新写回 shell 管道。
- demo / smoke 必须使用临时 `CHOVY_HOME` + `CHOVY_E2E_USE_MOCK=1`，避免污染用户真实配置或依赖外部网络/API。
- demo 覆盖的 5 条创新主线保持：ATP bench、SwarmR 100 mock、TMT memory smoke、SCW context rebuild bench、CSG skill list；`/goal --help` 作为 bonus headless 入口。

**验收命令不变量**：
- Phase A-I 复验主线：`bun run typecheck`、`bun run smoke`、`bun run bench`、`bun run demo`。
- Phase H-I 重点复验：`bun run scripts/smoke-step27.ts`、`bun run scripts/smoke-step28.ts`、`bun run scripts/smoke-step29.ts`。
- Bench 输出 `WARN` 不阻断；typecheck、smoke、demo 失败应阻断。
- `queryEngine.ts ≤ 600 行` 仍是硬限；行数口径以 `scripts/smoke-step29.ts` 的 `trimEnd().split(/\r?\n/)` 为准。

## 26. 配置入口不变量（CLI / REPL）

> `chovy config` 与 REPL `/config` 是 provider/model/permission/API key 的统一交互式配置入口。

- API key **只**写入 `~/.chovy/secrets/<provider>`，文件内容只包含 key 本身且不追加换行；普通配置只写入 `~/.chovy/config.json`。
- `config.json` 中不得写入 `apiKey` / `secret` 类字段；配置向导写入时必须清理这类历史误配字段，同时保留 `swarm` / `memory` / `context` 等已有合法配置。
- 输出、日志、telemetry、文档示例和 smoke 失败信息都不得打印真实 key 明文；摘要只显示 `configured` / `missing`。
- provider 的 API key 环境变量名必须复用 `src/config/secrets.ts:envKeyFor(provider)` / `ENV_KEYS`，不要在 CLI、REPL 或文档生成逻辑中重复硬编码映射。
- 非 TTY 下 `chovy config` 不能等待 stdin；必须给出清晰错误，并提示手动编辑 `~/.chovy/config.json` 与 `~/.chovy/secrets/<provider>`，或使用 `--non-interactive`。
- 不引入 keychain、远程服务、网络请求或新依赖；不修改 `bin/chovy.js` / `bin/chovy.js.map` 构建产物。
