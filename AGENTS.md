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

当前阶段：**脚手架已完成，30 步开发计划文档已就绪（位于 `docs/`），尚未进入实施阶段**。

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
├── docs/                     # 33 份计划文档（README + architecture + innovations + step-01..30）
├── package.json              # Bun + React 18 + Ink 5 + Zod 3 + Commander 12
├── scripts/build.ts          # bun.build 打包脚本
├── 源码解析.md                # cc-haha 源码解读（参考资料，非本仓库代码）
└── src/
    ├── index.ts              # public barrel
    ├── version.ts
    ├── agent/agent.ts        # 最小 agent loop（completion → tool → repeat）
    ├── cli/index.tsx         # commander 入口（一次性 prompt 模式）
    ├── cli/components/       # AgentRepl + StatusLine
    ├── config/               # zod env 配置
    ├── logger/               # leveled logger
    ├── providers/            # registry + openai 参考实现 + 6 个 scaffold
    ├── tools/                # registry + echo 参考工具
    └── types/                # provider / messages / tool 契约
```

**已具备**：Bun + Ink 工具链、Provider/Tool 注册中心、最小 agent loop 与流式 UI 渲染。
**未实现**：真实工具、权限/沙箱、子智能体、记忆、目标循环、上下文管理、技能、所有非 OpenAI provider 的真实接线。

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
5. 别忘了在文档中找一个合适的命名空间（fs / exec / web / meta）。

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
- ❌ 直接读 / 写文件不走 `safeFs`（步骤 04 后接入）。
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
chovy /goal "<objective>"        # 长程任务
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
