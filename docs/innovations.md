# chovy-code 创新差异化方案

> 这份文档定义了 chovy-code **不同于 Claude Code / cc-haha 的 5 项核心创新 + 2 项辅助创新**。
> 所有创新都对应到 §3 中具体步骤，并指出在借鉴源（cc-haha）基础上的关键差异。

---

## 一图速览

| 缩写 | 名字 | 解决什么问题 | 主要步骤 |
|---|---|---|---|
| ATP | Adaptive Tool Protocol | 工具描述占用上下文太多 / 跨模型无法 1:1 复用 | 06,07 |
| SwarmR | Swarm Router + Judge | 多任务/多视角并行 + 结构化整合 | 18,20,21,22 |
| TMT | Tiered Memory Tree | 跨会话记忆 + 全文检索 + 自动注入 | 24,25,26 |
| SCW | Smart Context Window | 接近上限不崩溃；自动 checkpoint + 重建 | 27,28 |
| CSG | Conditional Skill Graph | 技能不能盲目全注入；要按图选择 | 29 |
| PSF | Prompt Shape Fingerprint | 对所有 provider 通用化"缓存友好性"诊断 | 15 |
| PCM | Provider Capability Matrix | 多 provider 之间能力差导致代码分叉 | 17 |

---

## 1. ATP — Adaptive Tool Protocol（自适应工具协议）

### 1.1 痛点

cc-haha 中工具描述（`description(input, ctx)`）每次都全文注入，43 个工具至少 8–12k tokens。
当上下文压力大、或 provider 上下文窗口小（如 Kimi 早期 128k 看似充足但工具描述+system+memory 已占 30k）时，
工具描述占比过高、剩余推理空间被挤压。

### 1.2 创新

每个工具同时声明两份描述：

```ts
interface Tool {
  name: string;
  schema: ZodSchema;
  desc: {
    lean: string;           // ≤ 1 行，约 80–150 tokens
    full: string;           // 完整版，含示例、边界、安全提示
    examples?: string[];    // 可选：再省时不注入
  };
  // 触发"全描述"的提示词关键词；命中时该工具升级为 full
  fullTriggers?: RegExp[];
  /** 互斥族；同族工具一次最多注入 1 个 full（其余 lean）*/
  family?: string;
  run(args, ctx): Promise<ToolResult>;
}
```

运行时由 **Tool Budget Allocator (TBA)**（步骤 07）按以下算法选描述：

```
input: 用户最近 N 条消息 + 当前 systemPrompt 已用 tokens + ctx_window
output: 每个工具选 lean 还是 full

1. 先全部置 lean
2. 计算剩余预算 budget = ctx_window * 0.4 - alreadyUsed
3. 按"工具相关度分"排序：
   - 用户消息中关键词命中 fullTriggers → 强相关
   - 上一轮调用过的工具 → 中相关
   - examples 命中文件类型 / 操作动词 → 弱相关
4. 在不超 budget 的前提下，逐个升级为 full
5. 同 family 仅升一个
```

### 1.3 与 cc-haha 的差异

| 维度 | cc-haha | chovy-code |
|---|---|---|
| 描述形态 | 单一 description | lean + full |
| 选择时机 | 静态（永远全文） | 动态（按预算 + 相关度） |
| 优化目标 | Anthropic prompt cache 命中 | 通用所有 provider 的 token 成本 |
| 跨 provider | 不可移植 | 可移植 |

### 1.4 验收

- 工具描述总注入量 ≥ 30% 下降，准确率（命中正确工具）下降 < 3%。
- 当用户输入"列出当前目录文件"时，Glob 自动升 full、Bash 保持 lean。

---

## 2. SwarmR — Swarm Router + Judge Aggregator（子智能体路由 + 裁判聚合）

### 2.1 痛点

- 单个主 agent 串行调用工具，分析复杂代码库需要 10+ 轮，慢且成本高。
- cc-haha 的 Coordinator 是"manual 派单"：让用户/主 agent 写文字给队友。
- 没有结构化整合，输出靠 LLM 自然语言总结，不可机器读。

### 2.2 创新

**主 agent 提供工具 `dispatch`**：

```ts
type DispatchInput = {
  prompts: Array<{
    id?: string;            // 默认按数组下标
    prompt: string;
    role?: 'critic' | 'verifier' | 'planner' | 'explorer' | 'custom';
    provider?: ProviderId;  // 可异构：critic 用 Claude，explorer 用 Haiku/GLM-Air
    model?: string;
    tools?: string[];       // 工具白名单
    maxTokens?: number;
    timeoutMs?: number;
  }>;
  judge?: {
    provider?: ProviderId;  // 默认 GLM-4.5 / Kimi-K2 / DeepSeek
    schema: 'consensus' | 'compare' | 'rank' | 'custom';
    customSchema?: ZodSchema;
  };
  parallelism?: number;     // 默认 8，最大 100
  shareSession?: boolean;   // 是否共享当前会话上下文（默认 true）
};

type DispatchOutput = {
  spawnedIds: string[];
  results: SubAgentResult[];
  judgement: JudgedAggregate;
};
```

**子 agent 共享会话上下文**：通过传入压缩快照（最近 N 条 + MEMORY.md + 当前任务 progress），
而不是从零开始；子 agent 看到 `<parent-session-snapshot>` 段落。

**裁判模型**输出 zod 强约束 schema：

```ts
const ConsensusSchema = z.object({
  agreement: z.enum(['strong', 'weak', 'split', 'conflict']),
  evidence: z.array(z.object({
    fromAgentId: z.string(),
    excerpt: z.string(),
    weight: z.number(),
  })),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()),
  final_answer: z.string(),
  confidence: z.number().min(0).max(1),
});
```

### 2.3 生命周期与可观测

每个子 agent：

```ts
type SubAgentHandle = {
  id: string;
  parentId: string;
  prompt: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;                 // 自报告，例如 "reading file X"
  spawnedAt: number;
  finishedAt?: number;
  costUSD: number;
  tokensIn: number;
  tokensOut: number;
  cancel(): Promise<void>;
};
```

主 agent 通过 `listSubAgents()` 工具查看；CLI Ink UI 提供 `SwarmPanel`，按 `Ctrl-X` 取消选中的子 agent。

### 2.4 上限

- **硬上限 100**：在 `swarm/router.ts` 的常量中；超出抛错而非沉默截断。
- **软上限 8 并发**：可由用户调高（`CHOVY_SWARM_PARALLELISM`）。
- **全局 cost cap**：`CHOVY_SWARM_BUDGET_USD`（默认 $0.5/dispatch）。

### 2.5 与 cc-haha 的差异

| 维度 | cc-haha | chovy-code |
|---|---|---|
| 分发方式 | SendMessage 工具，纯文本 | dispatch(N) 一次声明 + 并发 |
| 整合方式 | 主 agent 自己读 | 裁判模型 + zod schema |
| 共享上下文 | 文档/模糊 | 显式 snapshot 注入 |
| 取消机制 | 通过 TaskStop | UI 快捷键 + token + ctx |
| 异构 provider | 同一套 | 每个 sub agent 可指定 provider |

---

## 3. TMT — Tiered Memory Tree（分层记忆树 + 全文索引）

### 3.1 四层结构

| 层 | 存储 | 写入者 | 用途 |
|---|---|---|---|
| L1 — 项目记忆 | `MEMORY.md` | 用户 + AI（受控） | 长期决策 / 编码规范 / 架构 |
| L2 — 检查点 | `checkpoints/*.md` | checkpoint-writer 子 agent 自动 | 结构化会话快照 |
| L3 — 笔记暂存 | `notes.md` | 主 agent | 临时草稿 |
| L4 — 任务进展 | `tasks/<id>/progress.md` | 主/子 agent | 长程任务日志 |

### 3.2 持久化

底层用 **Bun 内置 `bun:sqlite`** 建索引：

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  layer TEXT NOT NULL,           -- 'project' | 'checkpoint' | 'notes' | 'progress'
  type TEXT NOT NULL,            -- 'decision' | 'rule' | 'fact' | 'pref' | 'snapshot' | ...
  source_path TEXT,              -- MEMORY.md / checkpoints/x.md / ...
  content TEXT NOT NULL,
  tags TEXT,                     -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  importance INTEGER DEFAULT 50  -- 0–100
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags,
  content='memories',
  content_rowid='rowid'
);
```

### 3.3 自动注入流程（步骤 25）

会话恢复时：

```
loadProject(cwd) 
  → readMemoryFiles()        # 4 个层级
  → indexIfStale()           # 文件比 db 更新时重建索引
  → score(currentPrompt)     # 用语义指纹 + FTS 相关度
  → pickWithBudget(4 KB)     # 预算化
  → injectAsSystemPart()     # 加到 system prompt 的 [memory] 段
```

### 3.4 与 cc-haha 的差异

| 维度 | cc-haha memdir | chovy-code TMT |
|---|---|---|
| 存储 | 仅文件（MEMORY.md + 索引） | 文件 + sqlite + FTS5 |
| 检索 | 注入整个 MEMORY.md（≤200 行） | 按相关度选 top-K，预算化 |
| 4 类记忆 | 通过 type 字段在文件里 | 文件分层 + db type 双索引 |
| 跨会话 | 同一个 MEMORY.md 文件 | + checkpoint/snapshot 自动恢复 |
| 全文搜索 | 无 | FTS5 毫秒级 |

---

## 4. SCW — Smart Context Window（智能上下文窗口）

### 4.1 三个能力

#### 4.1.1 自适应阈值

```ts
function thresholds(model: string) {
  const ctx = providerCapabilities(model).contextWindow;
  return {
    soft: Math.floor(ctx * 0.75),  // 触发"提示主 agent 收尾"
    hard: Math.floor(ctx * 0.90),  // 触发自动 checkpoint + 重建
    reserve: 4000,                 // 预留输出
  };
}
```

#### 4.1.2 自动 checkpoint

当 tokens 用量越过 `soft` 时，调用 checkpoint-writer 子 agent（步骤 26）：
*结构化输出* 当前任务摘要、已完成步骤、未完成项、关键文件、下一步意图，写到 `checkpoints/latest.md`。

#### 4.1.3 上下文重建（步骤 28）

越过 `hard` 时：

```
新 system = base + memory(top-K) + latest checkpoint + active task progress
新 messages = [
  { role: 'system', content: '<context-rebuilt-from-checkpoint />' },
  ...lastK messages (默认 K=8),
]
```

旧消息丢弃，但完整流写入 `~/.chovy/projects/<x>/sessions/<id>.jsonl` 留存。

### 4.2 预算化注入（核心差异）

```ts
type ContextBudget = {
  systemBase: number;     // ~1500
  memory: number;         // 4000
  checkpoint: number;     // 2000
  notes: number;          // 1000
  taskProgress: number;   // 1500
  skills: number;         // 8000
  tools: number;          // ATP 动态计算
  history: number;        // 剩余
};
```

每个段都有上限，超出按 *importance × recency* 双因子打分裁剪。

### 4.3 与 cc-haha 的差异

| 维度 | cc-haha autoCompact | chovy-code SCW |
|---|---|---|
| 触发 | 单一阈值 → 总结 | 双阈值（soft 提示 + hard 重建） |
| 重建材料 | 由模型自总结 | 来自 checkpoint + memory + progress（结构化） |
| 预算化 | 隐式 | 显式 ContextBudget |
| 取消恢复 | 无 | 重建后可"回滚到上一个 checkpoint" |

---

## 5. CSG — Conditional Skill Graph（条件化技能图）

### 5.1 痛点

cc-haha 的技能是平铺目录 + Token 预算（约 8k 字符）。问题：

- 选择是"按关键词匹配"或"AI 看名字猜"，命中率低；
- 技能间有依赖关系（"commit" 需要 "format" 之前跑），但没有显式声明。

### 5.2 创新

```ts
interface Skill {
  name: string;
  summary: string;            // 一行
  triggers: {
    keywords?: string[];
    patterns?: RegExp[];
    when?: 'always' | 'on-request' | 'pre-tool' | 'post-tool';
  };
  requires?: string[];        // 依赖的其他技能名
  provides?: string[];        // 暴露的能力 token
  conflicts?: string[];       // 不能与之同台
  systemFragment: string;     // 注入到 system prompt 的片段
  budgetTokens: number;       // 自报告
}
```

**Skill Planner**（步骤 29）流程：

```
1. 从 prompt 抽取意图标签（小模型/正则两路）
2. 在 skill 图上做拓扑搜索，命中 + 满足 requires
3. 解决 conflicts（同 conflicts 组取得分最高一个）
4. 按 budgetTokens 累加，超出 ContextBudget.skills 时裁剪低分
5. 输出选定 skill 链 + 注入片段
```

### 5.3 例子

```
用户: "帮我修这个 bug 然后提交"
  → 意图: ['bug-fix', 'commit']
  → 选: refactor-safety, format-on-save, conventional-commit, pre-push-tests
  → conflicts: format-on-save 与 trailing-comma 冲突，按上下文得分选 format-on-save
```

### 5.4 与 cc-haha 的差异

| 维度 | cc-haha skills | chovy-code CSG |
|---|---|---|
| 选择 | 按关键词 | 图遍历 + 拓扑 |
| 依赖 | 隐式 | requires/provides/conflicts |
| 预算 | 8k 字符全局 | 单技能自报告 + 全局预算 |
| 可组合 | 弱 | 强（明确依赖） |

---

## 6. PSF — Prompt Shape Fingerprint（辅助创新）

### 6.1 动机

cc-haha 的 `promptCacheBreakDetection.ts` 是 Anthropic-only 的 cache 命中诊断。
chovy-code 把它通用化为"prompt 结构稳定性指纹"——所有 provider 受益。

### 6.2 实现

每次构建 system prompt 后计算指纹：

```ts
type PromptShape = {
  modelId: string;
  systemHash: number;
  toolsHash: number;
  toolNames: string[];
  perToolHash: Record<string, number>;
  systemBytes: number;
  injectedSegments: string[];   // ['memory', 'checkpoint', 'skills', ...]
  ts: number;
};
```

存到 `~/.chovy/telemetry/prompt-shapes.jsonl`。CLI 提供 `chovy prompt diff` 命令对比两次会话的指纹差异，用于：

- 追踪 system prompt 漂移；
- 解释成本变化；
- Anthropic 用户额外获得 cache 命中诊断（保留原能力）。

---

## 7. PCM — Provider Capability Matrix（辅助创新）

### 7.1 矩阵

```ts
interface ProviderCapabilities {
  contextWindow: number;
  supportsStreaming: boolean;
  supportsTools: 'native' | 'json-mode' | 'prompted' | 'no';
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsParallelToolCalls: boolean;
  maxOutputTokens: number;
  pricing?: { in: number; out: number; cacheRead?: number };
  family?: 'gpt' | 'claude' | 'gemini' | 'glm' | 'kimi' | 'deepseek' | 'minimax';
}
```

### 7.2 降级路径

| 能力 | 缺失时降级方案 |
|---|---|
| native tools | → json-mode（让模型输出工具调用 JSON） → prompted（约定 `<tool_use>` 标签） |
| streaming | → 一次性返回，UI 静默等待 |
| parallel tool calls | → 串行执行 |
| json-mode | → 后处理用 zod 修复（`tryFixJSON`） |

主 agent 与子 agent 都通过 `getCapability(model)` 决定能力，避免硬编码 if-else。

---

## 8. 组合效应

把 5 个核心创新串起来：

```
用户输入 "/goal 让项目 typecheck"
  ↓
[CSG] Skill Planner 选 "ts-fix" 链
  ↓
[ATP] Tool Budget Allocator 给 Edit / Bash 升 full
  ↓
[QueryEngine] 主 agent 决定分发 4 个子 agent
  ↓
[SwarmR] dispatch(["扫 typecheck 错误", "改 file A", "改 file B", "改 file C"])
  ↓
[Judge] 聚合：哪些修复冲突、哪些重复
  ↓
[TMT] 写入 progress.md 并触发 checkpoint
  ↓
[SCW] 监控 token，超 soft → checkpoint，超 hard → 重建
  ↓
[Goal Loop] convergence?  bun typecheck 通过 → finish；否则下一轮
```

---

## 9. 创新落地与 30 步映射

| 创新 | 主步骤 | 测试用例 |
|---|---|---|
| ATP | 06,07 | 大量工具下 system prompt 体积 |
| SwarmR | 18,20,21,22 | 100 子 agent 压力 + 取消 + 异构 |
| TMT | 24,25,26 | 第二次进入会话注入正确率 |
| SCW | 27,28 | 长对话不崩溃 + 重建后任务连续 |
| CSG | 29 | 多技能依赖正确解析 |
| PSF | 15 | 两次会话指纹 diff 可读 |
| PCM | 17 | 7 provider 全通过冒烟 |

---

## 10. 不做（明确边界）

- **不做** GrowthBook 等远程 feature gating（本地 features.json 即可）；
- **不做** Anthropic-only 的 prompt cache 价格优化（只保留诊断）；
- **不做** Docker / VM 沙箱（path-prefix-allowlist + Bun 子进程足够）；
- **不做** 团队记忆共享（cc-haha TEAMMEM 路线，留作后续）；
- **不做** 虚拟宠物 / Buddy 系统（与目标无关）；
- **不做** 语音模式（与目标无关）。
