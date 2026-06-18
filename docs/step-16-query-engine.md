# Step 16 — QueryEngine（取代当前 agent.ts）

**Phase**: D | **依赖**: 12,15 | **可并行**: ❌（B2 屏障） | **估时**: 8h

## 目标

实现 **chovy-code 的核心循环**——QueryEngine。它是后续所有 agent / swarm / goal 的运行时基础。
取代当前 `src/agent/agent.ts` 的简易 loop。

## 产物

```
src/engine/
├── queryEngine.ts       # 主类
├── messageNormalize.ts  # 消息规范化（多 provider 适配）
├── streamHandler.ts     # 流式增量处理
├── costTracker.ts       # 成本追踪
└── index.ts
src/agent/
└── runAgent.ts          # 通用 agent 运行器（包装 QueryEngine + lifecycle）
```

旧 `src/agent/agent.ts` 保留兼容层，转发到新引擎。

## QueryEngine API

```ts
export interface QueryRunOptions {
  messages: ChatMessage[];
  systemPromptOpts?: BuildOptions;
  provider: ProviderId;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];                 // 默认全部已注册
  toolBudgetTokens?: number;
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
  agentRole?: AgentRole;          // 用于 ATP 角色亲和度
  agentId?: string;               // 用于子 agent
  parentId?: string;
  contextBudget?: ContextBudget;  // 步骤 27/28 注入
  onToken?(delta: string): void;
  onMessage?(msg: ChatMessage): void;
  onToolStart?(name: string, args: unknown): void;
  onToolEnd?(name: string, result: ToolResult): void;
  onUsage?(usage: TokenUsage): void;
}

export interface QueryRunResult {
  finalContent: string;
  messages: ChatMessage[];        // 包含本轮新增（含 tool 结果）
  costUSD: number;
  tokens: { in: number; out: number; cacheRead?: number };
  rounds: number;
  stopReason: 'final' | 'maxRounds' | 'cancelled' | 'budgetExceeded';
}

export class QueryEngine {
  constructor(private deps: { permissions: PermissionEngine; hooks: HookEngine; logger: Logger; ... });
  async run(opts: QueryRunOptions): Promise<QueryRunResult>;
}
```

## 主循环（伪码）

```
init: messages = opts.messages copy
loop round = 0..maxRounds:
  // 1. 构建 system prompt
  effective = buildEffectiveSystemPrompt(opts.systemPromptOpts)

  // 2. ATP 描述工具
  described = describeTools({ tools, budgetTokens: opts.toolBudgetTokens, recentMessages: messages.slice(-8), agentRole, lastCalledTools })

  // 3. 估算 token / 触发 SCW（步骤 27）
  if monitor.shouldRebuild(messages, effective) → rebuild + continue

  // 4. 规范化消息（处理 tool_use / tool_result 块、reasoning 等）
  normalized = normalizeForProvider(provider, messages)

  // 5. 调用 provider
  await hooks.run('PreApiCall', { effective, tools: described })
  completion = await provider.complete/stream({ ... })
  costTracker.record(...)

  // 6. 处理结果
  push assistant message
  if no tool calls → return final
  if cancelled → return cancelled

  // 7. 工具循环
  for each toolCall:
    decision = await permissions.check(toolName, args)
    if deny → push tool error
    else:
      await hooks.run('PreToolUse', ...)
      result = await tool.run(args, ctx)
      await hooks.run('PostToolUse', ...)
      push tool message
  
  // 8. 进入下一轮
```

## 关键差异（相对当前 agent.ts）

| 维度 | 当前 agent.ts | 新 QueryEngine |
|---|---|---|
| 工具描述 | 直接 describeTools（全文） | ATP 动态选择 |
| 权限 | 无 | 6 层引擎 + 钩子 |
| 系统 prompt | 单行常量 | 5 层 + 分区 + PSF |
| 上下文 | 无监控 | SCW 监控 + 自动 checkpoint（step-27/28 接入） |
| 子 agent | 无 | spawnSubAgent 支持（step-18） |
| 成本 | 无追踪 | costTracker 全维度 |
| 取消 | 无 | abortSignal + cancel 协议 |

## 取消协议

- 用户按 Esc / Ctrl+C → 调 abortController.abort()；
- QueryEngine 检测到 abortSignal.aborted 后：
  1. 关闭流式 SSE；
  2. 向运行中的工具传递信号；
  3. 等待至多 2s 优雅退出；
  4. 否则 force-kill 子进程；
  5. 返回 stopReason='cancelled'。

## 成本追踪

```ts
interface CostTracker {
  record(provider, model, usage, cacheUsage?): void;
  total(): { usd: number; tokensIn: number; tokensOut: number };
  perModel(): Record<string, { usd: number; ... }>;
  reset(): void;
}
```

每个 model 的单价由 `providers/capabilities.ts` 提供（步骤 17）。

## 验收标准

- 旧 `runAgent` 测试用例继续通过；
- 单工具循环（"echo hello"）成本约 $0.000x，在 telemetry 可见；
- abort 后 1s 内 stopReason='cancelled'；
- 多工具调用并行（provider 支持 parallel_tool_calls 时）实际并发执行。

## 参考源

- `cc-haha/src/QueryEngine.ts` (1295 行)、`query.ts` (1729 行)

## 风险

- 多 provider 流式格式差异 → 在 streamHandler.ts 中按 capability 分支；保留中间事件 type 抽象。
- QueryEngine 体量易膨胀 → 限定 ≤ 600 行；其余拆出 helper。
