# Step 18 — Sub-Agent Runtime（生命周期 / 取消 / 后台）

**Phase**: E | **依赖**: 16 | **可并行**: ❌（E 阶段第一步） | **估时**: 6h

## 目标

实现子智能体运行时——主 agent 通过 `ctx.spawnSubAgent` / 工具 `agent` / 工具 `dispatch`（步骤 20）创建子 agent。
覆盖 **生命周期追踪、取消、后台执行、上下文共享**。

## 产物

```
src/agent/
├── runAgent.ts             # 通用执行（含主/子）
├── lifecycle.ts            # SubAgentHandle 状态机
├── pool.ts                 # 内存池 + id 分配 + 上限 100
├── snapshot.ts             # 父→子 上下文快照（创新点之一）
├── builtin/                # 步骤 19 填充
└── index.ts
```

## SubAgentHandle 与状态机

```ts
export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused';

export interface SubAgentHandle {
  id: string;                    // 'sa_' + base36 8 chars
  parentId: string;
  role: AgentRole;
  prompt: string;
  status: AgentStatus;
  phase: string;                 // 子 agent 自报告，如 "reading file X"
  spawnedAt: number;
  finishedAt?: number;
  costUSD: number;
  tokensIn: number;
  tokensOut: number;
  provider: ProviderId;
  model: string;
  background: boolean;
  cancel(): Promise<void>;
  result?: SubAgentResult;
}

export interface SubAgentResult {
  ok: boolean;
  content: string;
  structuredOutput?: unknown;
  costUSD: number;
}
```

状态转移：

```
queued → running ─┬─▶ done
                  ├─▶ failed
                  ├─▶ cancelled
                  └─▶ paused (goal-loop 暂停)
```

## SpawnFn

```ts
export type SpawnFn = (input: SpawnInput) => Promise<SubAgentHandle>;

export interface SpawnInput {
  role?: AgentRole;
  prompt: string;
  provider?: ProviderId;
  model?: string;
  tools?: string[];                // 工具白名单
  disallowedTools?: string[];
  systemPromptOverride?: string;
  shareSession?: boolean;          // 默认 true：注入父会话快照
  background?: boolean;            // 默认 false
  budgetUSD?: number;              // 单 agent 成本上限
  timeoutMs?: number;
  permissionMode?: PermissionMode; // 默认继承父
  contextSnapshotOverride?: ContextSnapshot;
}
```

## 上下文共享（创新点）

`snapshot.ts` 把父会话压缩为：

```ts
export interface ContextSnapshot {
  recentMessages: ChatMessage[];   // 最近 K 条（默认 6）
  memorySummary: string;           // MEMORY.md top-K 注入项
  activeTaskProgress?: string;     // 当前任务 progress.md 摘要
  decisions: string[];             // checkpoint 中的关键决策
  parentRole: AgentRole;
  parentObjective?: string;        // 当前目标
}
```

子 agent 的 system prompt 中插入 `<parent-session-snapshot>` 段（在 agent layer，第 2 层）。

## 取消机制

- 每个 SubAgentHandle 有自己的 AbortController；
- 父 agent 可调 handle.cancel() 或全局 swarm.cancelAll(predicate)；
- UI Ctrl-X 选中条目 → cancel；
- 取消后状态变 cancelled，最终结果包含 reason；
- 取消传播到子 agent 内部的工具（包括 BashTool 子进程的 SIGTERM）。

## 后台执行

`background: true` 时：
- spawn 立即返回 handle（status=running），不阻塞父；
- 父 agent 可通过 `agent` 工具的"list/get"模式查询；
- 完成后通过事件通道（in-memory bus）通知 UI。

## 池与上限

```ts
class SubAgentPool {
  private map = new Map<string, SubAgentHandle>();
  private static MAX = 100;        // 硬上限
  spawn(input): Promise<SubAgentHandle>;
  list(filter?): SubAgentHandle[];
  get(id): SubAgentHandle | undefined;
  cancel(id): Promise<void>;
  cancelAll(predicate?): Promise<void>;
}
```

超 100 时新 spawn 直接抛 `ChovyError('AGENT_BUDGET_EXCEEDED')`。

## 配额与熔断

- 每个 SubAgent 默认 maxRounds=12；
- 默认 budgetUSD=$0.20；
- 默认 timeoutMs=120s；
- 任一触发 → status=failed。

## 验收标准

- 父 agent 调用 `agent` 工具能拿到一个 handle；
- background=true 时父 agent 可继续其他工具；
- 取消能在 ≤ 2s 内反映在 handle.status；
- 100 个并发 spawn 后第 101 个抛错。

## 参考源

- `cc-haha/src/tools/AgentTool/`、`runAgent.ts`、`coordinator/workerAgent.ts`

## 风险

- 子 agent 流式 UI 拥挤 → 步骤 22 处理；本步只保证数据结构完整。
