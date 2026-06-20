# Step 01 — Types & Unified Error Model

**Phase**: A (Foundation) | **依赖**: 无 | **可并行**: ✅ | **估时**: 3h

## 目标

在现有 `src/types/` 基础上扩展全局类型契约，统一错误模型，为后续所有模块提供单一真相源（single source of truth）。

## 产物

```
src/types/
├── messages.ts        # 已存在，扩充 reasoning / annotations
├── provider.ts        # 已存在，扩充 capabilities
├── tool.ts            # 已存在，扩充为 v2 契约草案
├── agent.ts           # 新：SubAgentHandle, AgentLifecycle, AgentRole
├── memory.ts          # 新：MemoryRecord, MemoryLayer, MemoryQuery
├── goal.ts            # 新：GoalState, GoalPhase, ConvergenceCriteria
├── skill.ts           # 新：Skill, SkillNode (CSG 用)
├── hook.ts            # 新：HookEvent, HookHandler, HookOutcome
├── context.ts         # 新：ContextBudget, ContextSnapshot
└── errors.ts          # 新：ChovyError 类层次
```

## 实现要点

### 1. 错误模型（核心）

```ts
// src/types/errors.ts
export type ErrorCode =
  | 'PROVIDER_NOT_READY' | 'PROVIDER_API_ERROR' | 'PROVIDER_RATE_LIMIT'
  | 'TOOL_NOT_FOUND' | 'TOOL_INVALID_ARGS' | 'TOOL_DENIED' | 'TOOL_TIMEOUT'
  | 'PERMISSION_DENIED' | 'PERMISSION_HOOK_BLOCKED'
  | 'CTX_OVERFLOW' | 'CTX_REBUILD_FAILED'
  | 'MEMORY_IO' | 'MEMORY_INDEX_CORRUPT'
  | 'AGENT_CANCELLED' | 'AGENT_BUDGET_EXCEEDED' | 'AGENT_TIMEOUT'
  | 'GOAL_DIVERGED' | 'GOAL_MAX_ROUNDS'
  | 'CONFIG_INVALID' | 'INTERNAL';

export class ChovyError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ChovyError';
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message, meta: this.meta }; }
}

export function isChovyError(e: unknown): e is ChovyError {
  return e instanceof Error && (e as Error).name === 'ChovyError';
}
```

### 2. ChatMessage 扩展（保持向后兼容）

```ts
// src/types/messages.ts （增量）
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  // 新增
  id?: string;                // 消息 id（持久化用）
  ts?: number;                // 时间戳
  reasoning?: string;         // o1 / Claude thinking 等
  annotations?: Array<{       // citation / web_search 等富注释
    type: string;
    payload: unknown;
  }>;
}
```

### 3. agent.ts / memory.ts / goal.ts 草案

每个文件先定义最小可工作的接口，留 `// TODO step-XX` 标记：

```ts
// src/types/agent.ts
export type AgentRole = 'main' | 'explorer' | 'planner' | 'verifier'
                      | 'critic' | 'checkpoint-writer' | 'custom';

export interface SubAgentHandle {
  id: string;
  parentId: string;
  role: AgentRole;
  prompt: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  spawnedAt: number;
  finishedAt?: number;
  costUSD: number;
  tokensIn: number;
  tokensOut: number;
}
```

### 4. 类型导出统一

更新 `src/types/index.ts`，确保所有新文件被 barrel 导出。

## 验收标准

- `bun run typecheck` 通过；
- 新增类型不引入运行时代码（纯 .d.ts 友好）；
- 旧 `agent.ts`、`echo.ts` 等仍编译通过；
- 错误日志格式 `chovy.error: <CODE> <message>` 在 logger 中自动识别（依赖步骤 03）。

## 参考源（cc-haha）

- `src/types/message.ts`、`src/types/tool.ts`
- 错误模型在 cc-haha 较为分散；本步主张更紧凑的 ErrorCode 枚举。

## 风险

- 接口扩张过快导致后续步骤改动大 → 限定本步**只新增**，不修改既有签名。
