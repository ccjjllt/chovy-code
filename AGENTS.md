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

当前阶段：**Phase A（Foundation）、Phase B（Tool System v2）、Phase C（Harness）、Phase D（Agent Core：System Prompt + QueryEngine + 7 provider 真实接线）、Phase E（Sub-Agent + SwarmR + Judge + Agent UI）、Phase F（Goal Loop）全部完成构建并通过复验；下一步进入 Phase G（step-24 Memory Store）**。Phase A-E 复验报告见 `docs/complete/phase-a-e-acceptance.md`（本轮修复 4 个跨 step 隐患 P3-P6）；Phase F (step-23) 验收报告见 `docs/complete/step-23-acceptance.md`。
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
    └── types/                # provider / messages / tool / agent 契约
```

**已具备**：Bun + Ink 工具链、Provider/Tool 注册中心、QueryEngine 主循环（5 层 system prompt + ATP 描述选择 + 6 层权限 + 12 hook 事件 + 流式 + 成本追踪 + 取消协议）、Tool Protocol v2（lean/full 描述 + ATP 预算分配器）、10 个核心工具（fs / exec / web / meta 含 dispatch）、Harness 缰绳层（权限引擎 6 层决策 + hook 引擎 12 事件 + 文件系统/命令沙箱）、7 个真实 provider（OpenAI / Anthropic / Gemini / DeepSeek / GLM / Kimi / MiniMax）+ PCM 能力矩阵 + 通用 SSE 解析 + 工具格式适配（含 MiniMax json-mode 降级）、子 Agent 运行时（SubAgentHandle 状态机 + pool 100 上限 + 父→子上下文快照 + 取消 cascade + 后台执行 + 5 内置角色）、SwarmR dispatch 核心（并行 fan-out ≤100 + 异构 provider 路由 + 自实现 p-limit 并发限流 + 全局预算 sticky-trip 熔断 + 进度/生命周期 bus）、Judge 聚合（4 schema + provider fallback 链 + tryFixJSON 五步修复 + ≤1 次自我修复 + 大 N 截断 + 取消独立 AC）、Ink UI 面板（SwarmPanel + AgentRow + AgentDetail + HotkeyBar + swarmStore + outputBuffer + Tab 焦点 + 16ms 节流）。
各 Phase 的详细产物与验收结论见 `docs/complete/` 下对应报告；本文不逐步罗列。
**未实现**：记忆/checkpoint（TMT）、目标循环（/goal）、上下文管理（SCW）、技能图（CSG）、端到端集成（Phase F–I）。

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
