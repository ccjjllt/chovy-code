# chovy-code 架构总览

## 1. 目标目录树（30 步完成后）

```
chovy-code/
├── bin/chovy.js
├── scripts/build.ts
├── docs/                          # 本计划文档目录
└── src/
    ├── index.ts
    ├── version.ts
    │
    ├── cli/                       # 命令层
    │   ├── index.tsx              # commander 入口
    │   ├── repl.tsx               # 交互式 REPL（多轮）
    │   ├── commands/              # 子命令: chat / goal / mem / agent / skill
    │   └── components/            # Ink UI: AgentRepl / StatusLine / SwarmPanel / GoalPanel
    │
    ├── config/                    # zod 校验配置 + secrets
    │   ├── config.ts
    │   ├── secrets.ts             # 密钥读取 + 缓存
    │   └── features.ts            # 本地 feature flag
    │
    ├── logger/                    # 结构化日志 + telemetry sink
    │   └── logger.ts
    │
    ├── fs/                        # 跨平台 FS 抽象 + chovy 主目录
    │   ├── home.ts                # ~/.chovy/...
    │   ├── paths.ts
    │   └── safeFs.ts
    │
    ├── types/                     # 全局类型契约
    │   ├── messages.ts
    │   ├── provider.ts
    │   ├── tool.ts
    │   ├── agent.ts
    │   ├── memory.ts
    │   ├── goal.ts
    │   └── errors.ts
    │
    ├── providers/                 # 7 个 provider 真实实现
    │   ├── registry.ts
    │   ├── capabilities.ts        # 能力矩阵
    │   ├── openai.ts
    │   ├── anthropic.ts
    │   ├── gemini.ts
    │   ├── deepseek.ts
    │   ├── minimax.ts
    │   ├── glm.ts
    │   ├── kimi.ts
    │   └── streaming.ts           # SSE 通用解析器
    │
    ├── tools/                     # 工具系统 v2
    │   ├── registry.ts
    │   ├── budget.ts              # ATP — Tool Budget Allocator
    │   ├── describe.ts            # lean / full 描述选择
    │   ├── fs/
    │   │   ├── read.ts
    │   │   ├── write.ts
    │   │   ├── edit.ts
    │   │   ├── glob.ts
    │   │   └── grep.ts
    │   ├── exec/
    │   │   ├── bash.ts
    │   │   └── ast.ts             # bash AST 安全解析
    │   ├── web/
    │   │   ├── search.ts
    │   │   └── fetch.ts
    │   ├── meta/
    │   │   ├── todoWrite.ts
    │   │   ├── askUserQuestion.ts
    │   │   ├── skill.ts
    │   │   └── agent.ts           # AgentTool（启动子 agent）
    │   └── echo.ts                # 已存在
    │
    ├── harness/                   # 缰绳层
    │   ├── permissions/
    │   │   ├── engine.ts          # 6 层决策
    │   │   ├── modes.ts           # 5 种模式
    │   │   ├── denialTracking.ts  # 拒绝熔断器
    │   │   └── rules.ts           # ask/allow/deny 规则
    │   ├── hooks/
    │   │   ├── engine.ts          # 8 类事件 + 竞速
    │   │   ├── snapshot.ts
    │   │   └── settings.ts
    │   └── sandbox/
    │       ├── filesystem.ts      # 危险目录保护
    │       └── shellSandbox.ts
    │
    ├── prompts/                   # System Prompt 与片段
    │   ├── default.ts
    │   ├── boundary.ts            # 静态/动态分区
    │   ├── fingerprint.ts         # prompt-shape-fingerprint
    │   └── builders.ts            # buildEffectiveSystemPrompt（5 层）
    │
    ├── engine/                    # 核心循环
    │   ├── queryEngine.ts         # 取代当前 agent.ts
    │   ├── messageNormalize.ts
    │   ├── streamHandler.ts
    │   └── costTracker.ts
    │
    ├── agent/                     # 主 / 子 agent 抽象
    │   ├── runAgent.ts            # 通用 agent 运行器
    │   ├── builtin/
    │   │   ├── exploreAgent.ts
    │   │   ├── planAgent.ts
    │   │   ├── verifyAgent.ts
    │   │   ├── criticAgent.ts
    │   │   └── checkpointWriterAgent.ts
    │   ├── lifecycle.ts           # id / status / cancel / costUSD
    │   └── index.ts
    │
    ├── swarm/                     # 子智能体路由器（创新 SwarmR）
    │   ├── router.ts              # dispatch(N) + 并发控制
    │   ├── judge.ts               # 裁判模型 + 结构化聚合
    │   ├── schemas.ts             # zod 聚合 schema
    │   ├── pool.ts                # 子 agent 池 / 上限 100
    │   └── ui.ts                  # 进度上报通道
    │
    ├── goals/                     # /goal 长程任务
    │   ├── goalState.ts
    │   ├── goalHook.ts            # Stop hook
    │   └── convergence.ts         # 达成判据
    │
    ├── memory/                    # 持久化记忆（创新 TMT）
    │   ├── store.ts               # bun:sqlite + FTS5
    │   ├── types.ts               # 4 类记忆 schema
    │   ├── ranker.ts              # 相关性打分
    │   ├── injection.ts           # 跨会话注入
    │   ├── checkpointWriter.ts
    │   └── files/
    │       ├── memoryFile.ts      # MEMORY.md
    │       ├── notesFile.ts       # notes.md
    │       └── progressFile.ts    # tasks/<id>/progress.md
    │
    ├── context/                   # 智能上下文管理（创新 SCW）
    │   ├── monitor.ts             # token 计算 + 阈值
    │   ├── rebuilder.ts           # 重建协议
    │   └── budgets.ts             # 预算化注入
    │
    ├── skills/                    # 技能系统（创新 CSG）
    │   ├── registry.ts
    │   ├── graph.ts               # 条件化技能图
    │   ├── planner.ts             # Skill Planner
    │   └── bundled/
    │       ├── commit.ts
    │       ├── review.ts
    │       └── refactor.ts
    │
    └── telemetry/
        ├── localSink.ts
        └── events.ts
```

---

## 2. 模块依赖图

```
                        ┌──────────────┐
                        │  Foundation  │ types, config, logger, fs, cli
                        │   (01–05)    │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐     ┌──────────┐    ┌──────────┐
        │  Tools   │     │ Prompts  │    │ Memory   │ (24)
        │ (06–11)  │     │   (15)   │    │  Store   │
        └─────┬────┘     └────┬─────┘    └────┬─────┘
              │               │               │
              ▼               ▼               │
        ┌──────────┐     ┌──────────────┐     │
        │ Harness  │────▶│ QueryEngine  │◀────┘
        │ (12–14)  │     │   (16)       │
        └──────────┘     └──────┬───────┘
                                │
                                ▼
                        ┌──────────────┐
                        │ Providers    │ (17)
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────────┐  ┌──────────┐
        │ Agents   │───▶│   Swarm      │  │ Context  │ (27,28)
        │ (18,19)  │    │ (20,21,22)   │  │ Mgmt     │
        └─────┬────┘    └──────┬───────┘  └────┬─────┘
              │                │                │
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────────┐  ┌──────────┐
        │  Goal    │    │  Memory      │  │  Skills  │ (29)
        │  (23)    │    │ Inject (25)  │  │   CSG    │
        │          │    │ Checkpoint(26)│  │          │
        └──────────┘    └──────────────┘  └──────────┘
                          │
                          ▼
                  ┌──────────────┐
                  │ Integration  │ (30)
                  └──────────────┘
```

---

## 3. 并行执行 SWAR 划分

### 3.1 五路 worker 切分

| Worker | 步骤 | 关键产物 |
|---|---|---|
| W1（基础） | 01,02,03,04,05 | 类型 / 配置 / 日志 / FS / CLI |
| W2（工具） | 06,07,08,09,10,11 | Tool 协议 + ATP + 9 工具 |
| W3（缰绳/核心） | 12,13,14,15,16,17 | 权限 / Hook / Sandbox / Prompt / QueryEngine / Providers |
| W4（多 Agent） | 18,19,20,21,22,23 | 子 Agent / Swarm / Judge / Goal |
| W5（记忆/上下文/技能） | 24,25,26,27,28,29 | TMT / SCW / CSG |
| 合流 | 30 | E2E 集成 |

### 3.2 屏障同步点

- **B1 = 步骤 06 完成**：Tool 协议 v2 落地；W3/W4 才能写"会调用工具"的 mock。
- **B2 = 步骤 16 完成**：QueryEngine 替换旧 `agent.ts`；W4/W5 才能在真实循环中跑。
- **B3 = 步骤 17 完成**：至少 3 个 provider 真实可用（OpenAI / GLM / Anthropic）。
- **B4 = 步骤 24 完成**：Memory store 上线；W5 后续步骤需要它。

### 3.3 接口冻结时点（"先签约再施工"）

为了让并行不打架，以下接口必须在对应步骤的"产物 §1"内冻结：

| 接口 | 冻结时点 |
|---|---|
| `Tool`、`ToolContext`、`ToolResult` | 06 |
| `Permission`、`PermissionMode` | 12 |
| `HookEvent`、`HookHandler` | 13 |
| `SystemPromptLayer` | 15 |
| `QueryEngine.run()` 签名 | 16 |
| `Provider.complete/stream` 增强签名 | 17 |
| `SubAgentHandle`、`AgentLifecycle` | 18 |
| `MemoryRecord`、`MemoryQuery` | 24 |
| `ContextBudget` | 27 |
| `Skill`、`SkillNode` | 29 |

---

## 4. 关键状态机

### 4.1 Agent 生命周期（步骤 18 详）

```
created → queued → running ─┬─▶ done
                            ├─▶ failed
                            ├─▶ cancelled
                            └─▶ paused (goal 暂停时)
```

### 4.2 Context 阈值状态（步骤 27 详）

```
fresh ──token>soft──▶ pressure ──token>hard──▶ rebuild
   ▲                                              │
   └──────────────checkpoint+truncate─────────────┘
```

### 4.3 Goal Loop（步骤 23 详）

```
/goal set → run iteration → Stop hook
                ↑                │
                │      convergence?
                │                │
                └────不达成─────┤
                                 ▼
                              达成 → finish
```

---

## 5. 数据持久化布局

```
~/.chovy/
├── config.json            # 全局配置
├── features.json          # 本地 feature flag
├── secrets/               # 加密密钥（可选）
└── projects/
    └── <hash(cwd)>/       # 每个项目一份
        ├── MEMORY.md      # 项目记忆（人/AI 都可读写）
        ├── notes.md       # AI 暂存
        ├── memory.db      # bun:sqlite，FTS5 索引
        ├── checkpoints/
        │   ├── latest.md
        │   └── 2026-06-18T10-30-00.md
        ├── tasks/
        │   └── <task-id>/
        │       ├── meta.json
        │       └── progress.md
        ├── sessions/
        │   └── <session-id>.jsonl   # 流式消息日志
        └── skills.lock          # 已选技能图签名
```

---

## 6. 模块清单与"代码量预算"

> 用作分配工作量的粗略参考，不作为硬约束。

| 模块 | 估算代码行 | 难度 | 步骤 |
|---|---|---|---|
| types/ | 400 | ★ | 01 |
| config + logger + fs | 600 | ★ | 02–04 |
| cli + repl | 800 | ★★ | 05 |
| tools/ (协议 + 9 工具 + ATP) | 2500 | ★★★ | 06–11 |
| harness/ | 1800 | ★★★★ | 12–14 |
| prompts/ | 600 | ★★ | 15 |
| engine/ | 1500 | ★★★★ | 16 |
| providers/ × 7 | 1400 | ★★★ | 17 |
| agent/ + swarm/ | 1800 | ★★★★ | 18–22 |
| goals/ | 400 | ★★ | 23 |
| memory/ | 1400 | ★★★ | 24–26 |
| context/ | 700 | ★★★ | 27,28 |
| skills/ | 600 | ★★ | 29 |
| **合计** | **~14,500** | | |

---

## 7. 风险登记

| # | 风险 | 缓解 |
|---|---|---|
| R1 | bun:sqlite + FTS5 在某些平台缺少扩展 | 启动时探测；缺失则降级为内存倒排索引 |
| R2 | 7 个 provider 的差异（工具、流式、JSON mode） | Capability matrix + 显式降级路径 |
| R3 | Swarm 100 子 agent 的 token 成本失控 | 全局 budget + per-dispatch cost cap + 提前熔断 |
| R4 | 长程 /goal 进入死循环 | 最大轮次 + 收敛函数 + 用户中断 |
| R5 | Ink 渲染在 100 子 agent 时卡顿 | 仅渲染 top N（默认 8）+ 折叠 panel |
| R6 | 跨平台 Bash 沙箱 | Windows 自动切换 PowerShell；保留沙箱内"path-prefix-allowlist"主控 |

---

## 8. 验收主线（贯穿 30 步）

每完成一个 Phase，做一次"贯穿冒烟测试"：

| Phase | 冒烟脚本 |
|---|---|
| A | `chovy --version` 正常打印 |
| B | `chovy "echo hello via tool"` 触发 echo 工具 |
| C | `CHOVY_PERMISSION_MODE=plan chovy "edit file"` 拒写 |
| D | `chovy --provider glm "say hi"` 真实流式输出 |
| E | `chovy "compare these 3 files"` → swarm 分发 3 子 agent + 裁判输出 |
| F | `chovy /goal "项目通过 typecheck"` 自动迭代直到成功 |
| G | 第二次进入会话时自动注入 MEMORY.md 摘要 |
| H | 4k token 长会话自动 checkpoint + 重建 |
| I | `/commit`、`/review` 技能可调用 |
