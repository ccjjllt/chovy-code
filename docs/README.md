# chovy-code 开发计划总览

> 本目录是 **chovy-code 全量开发蓝图**。chovy-code 在借鉴 Claude Code / cc-haha 的"出厂哲学"基础上，
> 提出了一套面向多模型（OpenAI / Anthropic / Gemini / DeepSeek / MiniMax / GLM / Kimi）的 **创新差异化** 设计：
> 子智能体 Swarm Router、跨会话持久化记忆 + 全文索引、智能上下文预算注入、长程 `/goal` 任务循环、
> 工具调用的"自适应胖瘦"协议（ATP）。
>
> **范围**：本次仅产出 **计划文档**，不做任何编码。

---

## 0. 项目当前状态（脚手架已就绪）

```
chovy-code/
├── bin/chovy.js               # 已构建的 CLI 入口
├── package.json               # Bun + React 18 + Ink 5 + Zod 3 + Commander 12
├── scripts/build.ts           # bun.build 打包脚本
└── src/
    ├── index.ts               # public barrel
    ├── version.ts
    ├── agent/
    │   ├── agent.ts           # 已实现最小 agent loop（completion → toolcall → repeat）
    │   └── index.ts
    ├── cli/
    │   ├── index.tsx          # commander 入口
    │   └── components/        # AgentRepl + StatusLine
    ├── config/                # zod 校验的 env 配置
    ├── logger/                # leveled logger
    ├── providers/             # registry + openai 参考实现 + 6 个 scaffold
    ├── tools/                 # registry + echo 参考工具
    └── types/                 # ChatMessage / Tool / Provider 等契约
```

**已完成**：Bun + Ink 工具链、Provider/Tool 注册中心、最小 agent loop 与流式 UI。
**未实现**：真实工具、权限/沙箱、子智能体、记忆、目标循环、上下文管理、技能、所有非 OpenAI provider 的真实接线。

---

## 1. 总体路线图（10 阶段 / 30 步）

> 30 步按 **9 个阶段（Phase A–I）** 组织。每个阶段内部独立、可被多人 / 多 agent **并行** 推进；阶段之间存在显式依赖。
> 每一步都附 `step-XX-<slug>.md`，文件中包含目标、产物、详细实现要点、验收标准、参考 cc-haha 文件。

| Phase | 主题 | 步骤 | 并行度 |
|---|---|---|---|
| A | Foundation（类型 / 配置 / 日志 / 错误模型） | 01–05 | 5 步可并行 |
| B | Tool System v2（工具协议 + ATP 创新 + 9 个核心工具） | 06–11 | 06→07，08–11 可并行 |
| C | Harness（权限引擎 / Hook 引擎 / 沙箱） | 12–14 | 12→13→14 串行（强依赖） |
| D | Agent Core（System Prompt / QueryEngine / 流式协议） | 15–17 | 15 可并行；16→17 串行 |
| E | Sub-Agent System（子代理 + SwarmR 路由 + 裁判模型） | 18–22 | 18 → 19,20 并行 → 21,22 并行 |
| F | Goal Loop（`/goal` 长程任务） | 23 | 依赖 D + E |
| G | Memory System（4 类记忆 + 全文索引 + 自动注入） | 24–26 | 24 → 25,26 并行 |
| H | Smart Context Management（自动 checkpoint + 重建 + 预算化注入） | 27–28 | 27 → 28 串行 |
| I | Skills + 集成（技能系统 + 端到端连通） | 29–30 | 29 → 30 串行 |

> **30 步详细索引** 见下文 §3 与 [`step-01-...md`](./step-01-types-and-error-model.md) 起的逐步文档。

---

## 2. 创新差异化提案（独立详档：[`innovations.md`](./innovations.md)）

chovy-code 不"全量抄袭"Claude Code，而是在以下五条线上明确做差异化：

1. **ATP — Adaptive Tool Protocol（自适应工具协议）**
   工具同时声明 `lean` / `full` 两份描述；运行时由 *Tool Budget Allocator* 根据剩余上下文预算决定每次注入哪份。
   Claude Code 的工具 schema 是固定的；chovy-code 让"工具描述"本身成为可弹性资源。
2. **CSG — Conditional Skill Graph（条件化技能图）**
   技能不再是平铺的目录，而是有向图：`skill.requires` / `skill.provides`。
   Skill Planner 根据用户意图深度优先选择最少必要技能链注入，命中率显著高于"按关键词匹配"。
3. **SwarmR — Swarm Router（子智能体路由器）+ Judge Aggregator（裁判聚合）**
   主 Agent 通过 `dispatch()` 一次分发 N 个 prompt（最多 100），每个子 Agent 可选不同 provider/model；
   裁判模型（默认 GLM/Kimi 长上下文）按 *结构化 schema* 聚合输出（`agreement`、`evidence[]`、`risks[]`、`final_answer`）。
   生命周期：每个子 Agent 都有 `id / parentId / status / phase / cancelToken / spawnedAt / costUSD` 字段，可在 Ink UI 实时查看。
4. **TMT — Tiered Memory Tree（分层记忆树）+ FTS（全文检索）**
   四层：`MEMORY.md`（项目）/ `checkpoint.md`（结构化快照）/ `notes.md`（暂存）/ `tasks/<id>/progress.md`（任务日志）。
   底层使用 **Bun 内置 `bun:sqlite`** + FTS5，跨会话毫秒级全文搜索；恢复会话时自动注入相关条目。
5. **SCW — Smart Context Window（智能上下文窗口）**
   - 自适应阈值：根据 model 上下文窗口动态推算 `softLimit = ctx * 0.75`、`hardLimit = ctx * 0.9`。
   - 重建协议：超过 hardLimit 时丢弃旧消息，按 *最新 checkpoint + MEMORY.md + 当前任务 progress + 最近 K 条消息* 重建。
   - 预算化注入：用 `TokenBudget { memory: 4k, checkpoint: 2k, notes: 1k, skills: 8k }` 控制注入大小，按 *相关性分数* 排序。

附加创新（详见 innovations.md）：
- **Cache-Hash 通用化**：把 Anthropic Prompt Cache 的 break-detection 思路抽象为 `prompt-shape-fingerprint`，让所有 provider 都能受益（基于内容稳定性诊断而非 cache pricing）。
- **Provider Capability Matrix**：按能力（streaming、tools、vision、json-mode、cache）声明，agent loop 自适应降级。

---

## 3. 30 步详细索引

| # | 文件 | Phase | 名称 | 依赖 |
|---|---|---|---|---|
| 01 | [step-01-types-and-error-model.md](./step-01-types-and-error-model.md) | A | 类型补全 + 统一错误模型 | — |
| 02 | [step-02-config-and-secrets.md](./step-02-config-and-secrets.md) | A | 配置加载 + 多 provider Secret 管理 | — |
| 03 | [step-03-logger-and-telemetry.md](./step-03-logger-and-telemetry.md) | A | 结构化日志 + 本地 telemetry sink | — |
| 04 | [step-04-fs-and-paths.md](./step-04-fs-and-paths.md) | A | 跨平台 FS 抽象 + chovy 主目录 | — |
| 05 | [step-05-cli-shell.md](./step-05-cli-shell.md) | A | CLI 命令体系（subcommands + 交互式 REPL） | — |
| 06 | [step-06-tool-protocol-v2.md](./step-06-tool-protocol-v2.md) | B | 工具协议 v2 + **ATP 创新** | 01 |
| 07 | [step-07-tool-budget-allocator.md](./step-07-tool-budget-allocator.md) | B | Tool Budget Allocator + 描述选择器 | 06 |
| 08 | [step-08-fs-tools.md](./step-08-fs-tools.md) | B | Read/Write/Edit/Glob/Grep | 06 |
| 09 | [step-09-bash-tool.md](./step-09-bash-tool.md) | B | Bash 工具 + AST 解析 + 沙箱钩子 | 06 |
| 10 | [step-10-web-tools.md](./step-10-web-tools.md) | B | WebSearch / WebFetch | 06 |
| 11 | [step-11-meta-tools.md](./step-11-meta-tools.md) | B | TodoWrite / AskUserQuestion / Skill / Agent 元工具 | 06 |
| 12 | [step-12-permission-engine.md](./step-12-permission-engine.md) | C | 6 层权限决策引擎 + 5 种模式 | 06 |
| 13 | [step-13-hook-engine.md](./step-13-hook-engine.md) | C | 8 类钩子事件 + 竞速机制 | 12 |
| 14 | [step-14-sandbox.md](./step-14-sandbox.md) | C | 文件系统沙箱 + 危险文件名单 + 拒绝熔断器 | 12 |
| 15 | [step-15-system-prompt.md](./step-15-system-prompt.md) | D | 5 层 System Prompt 优先级 + 静态/动态分区 | 01 |
| 16 | [step-16-query-engine.md](./step-16-query-engine.md) | D | QueryEngine（取代当前简易 agent.ts） | 12,15 |
| 17 | [step-17-providers-real.md](./step-17-providers-real.md) | D | 7 个 provider 的真实接线 + 能力矩阵 + 降级 | 16 |
| 18 | [step-18-sub-agent-runtime.md](./step-18-sub-agent-runtime.md) | E | 子 Agent 运行时 + 生命周期 | 16 |
| 19 | [step-19-built-in-agents.md](./step-19-built-in-agents.md) | E | 内置 Explore / Plan / Verify / Critic 4 个子 agent | 18 |
| 20 | [step-20-swarm-router.md](./step-20-swarm-router.md) | E | **SwarmR 创新**：并行 dispatch + 100 子 agent 上限 | 18 |
| 21 | [step-21-judge-aggregator.md](./step-21-judge-aggregator.md) | E | 裁判模型 + 结构化聚合 schema | 20 |
| 22 | [step-22-agent-ui.md](./step-22-agent-ui.md) | E | Ink UI：子 agent 进度面板 + 取消快捷键 | 18 |
| 23 | [step-23-goal-loop.md](./step-23-goal-loop.md) | F | `/goal` 长程任务循环（达成判据 / Stop hook） | 18,16 |
| 24 | [step-24-memory-store.md](./step-24-memory-store.md) | G | bun:sqlite + FTS5 存储层 + 4 类记忆 schema | 04 |
| 25 | [step-25-memory-injection.md](./step-25-memory-injection.md) | G | **TMT 创新**：跨会话注入 + 相关性打分 | 24 |
| 26 | [step-26-checkpoint-writer.md](./step-26-checkpoint-writer.md) | G | checkpoint-writer 子 agent + 结构化快照 | 24,18 |
| 27 | [step-27-context-monitor.md](./step-27-context-monitor.md) | H | **SCW 创新**：自动 checkpoint 触发 + 阈值 | 17,26 |
| 28 | [step-28-context-rebuild.md](./step-28-context-rebuild.md) | H | 上下文重建协议 + 预算化注入 | 27,25 |
| 29 | [step-29-skill-graph.md](./step-29-skill-graph.md) | I | **CSG 创新**：技能图 + Skill Planner | 06,16 |
| 30 | [step-30-integration-and-e2e.md](./step-30-integration-and-e2e.md) | I | 端到端连通 + 演示脚本 + bench/smoke | 23,28,29 |

---

## 4. 推荐并行执行计划（"5 个独立 worker"视角）

如果按 **5 路并行子 agent** 推进，可以这样切分：

```
Worker-1（Foundation）:  01 → 02 → 03 → 04 → 05
Worker-2（Tools）:       06 → 07 → (08 ∥ 09 ∥ 10 ∥ 11)
Worker-3（Harness+Core）: 12 → 13 → 14 → 15 → 16 → 17
Worker-4（Swarm+Goal）:   18 → (19 ∥ 20) → 21 → 22 → 23
Worker-5（Memory+Ctx+Skill）: 24 → 25 → 26 → 27 → 28 → 29
最后由 Worker-1 合流，做 30
```

**屏障同步点**：
- Tools v2 的 `Tool` 接口（步骤 06）必须先于所有需要工具的步骤完成；
- QueryEngine（步骤 16）是 D/E/F/H 阶段的必选前置；
- Memory store（步骤 24）是 G/H 的前置。

---

## 5. 文档使用约定

- 每个 step 文件都包含：**目标 / 产物 / 实现要点 / 接口签名 / 验收标准 / 参考源 / 估时**。
- 接口签名以 TypeScript 形式出现，**仅用于规约**——不在本次任务中实际编码。
- "参考源" 指向 `cc-haha-main/src/...`，但仅作灵感来源；本项目主张 *最少必要复刻 + 5 项核心创新*。
- 估时为单人单线开发的 *理想小时数*，不含沟通/调试。

---

## 6. 关键设计决策记录（ADR 简录）

1. **不复刻 Anthropic 私有缓存机制**：以"prompt-shape-fingerprint" 抽象观测能力。
2. **存储用 `bun:sqlite`**：Bun 原生支持，零外部依赖；FTS5 满足全文搜索。
3. **裁判模型默认走长上下文 provider**：GLM-4.5 / Kimi-K2 / DeepSeek-V3，避免 OpenAI 32k 限制。
4. **不复刻 GrowthBook**：feature gate 用本地 `~/.chovy/features.json` + 环境变量 `CHOVY_FEATURE_*`。
5. **沙箱用 Bun 子进程 + path-prefix-allowlist**，不引入 Docker 依赖。
6. **子 Agent 上限 100**：硬编码上限 + 软限（默认 8 并发、可调）。
7. **`/goal` 实现走 Stop-hook + 收敛判据**，不引入额外的进程外调度器。

更多见 [`architecture.md`](./architecture.md) 与 [`innovations.md`](./innovations.md)。
