# Step 20 — Swarm Router（dispatch + 100 子 agent + 异构 provider）

**Phase**: E | **依赖**: 18 | **可并行**: ✅ | **估时**: 6h

## 目标

实现 **SwarmR** 创新核心——主 agent 通过单次调用 dispatch N 个子 agent，
支持异构 provider/model、并发控制、生命周期统一管理、共享会话上下文。

## 产物

```
src/swarm/
├── router.ts              # dispatch 主流程
├── pool.ts                # 复用步骤 18 的 SubAgentPool（thin wrapper）
├── concurrency.ts         # 并发限流
├── budgets.ts             # 全局成本上限
├── progress.ts            # 进度上报通道（给 UI）
└── index.ts
src/tools/meta/dispatch.ts # 暴露给 agent 的工具
```

## dispatch 工具协议

```ts
schema: z.object({
  prompts: z.array(z.object({
    id: z.string().optional(),
    prompt: z.string(),
    role: z.enum(['explore','plan','verify','critic','custom']).optional(),
    provider: z.enum(['openai','anthropic','gemini','deepseek','minimax','glm','kimi']).optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    maxTokens: z.number().optional(),
    timeoutMs: z.number().optional(),
    budgetUSD: z.number().optional(),
  })).min(1).max(100),

  judge: z.object({
    enabled: z.boolean().default(true),
    schema: z.enum(['consensus','compare','rank','custom']).default('consensus'),
    customSchema: z.unknown().optional(),
    provider: z.enum([...]).optional(),
    model: z.string().optional(),
  }).optional(),

  parallelism: z.number().min(1).max(100).default(8),
  shareSession: z.boolean().default(true),
  budgetUSD: z.number().optional(),    // 全局上限
});
```

返回：

```ts
{
  spawnedIds: string[];
  results: Array<{ id: string; ok: boolean; content: string; structuredOutput?: unknown; costUSD: number }>;
  judgement?: JudgedAggregate;         // step-21
  totalCostUSD: number;
}
```

## 算法

```
1. 校验 prompts.length ≤ 100；prompts.length + currentRunningSubAgents ≤ MAX；
2. 计算每个 prompt 的 ContextSnapshot（默认共享父会话快照）；
3. 用 p-limit-like 限流器，按 parallelism 并发 spawn；
4. 收集结果（按原数组顺序）；
5. 若 budgetUSD 超出，触发 abort：取消未完成的子 agent，返回 partial；
6. 若 judge.enabled，调用步骤 21 的聚合器；
7. 写 telemetry 'swarm.dispatch'；
8. 返回 DispatchOutput。
```

## 异构 provider 路由

每个 sub-prompt 可独立指定 provider/model。例：

```ts
dispatch({
  prompts: [
    { role:'explore', prompt:'扫工程', provider:'glm', model:'glm-4-air' },
    { role:'plan',    prompt:'计划',   provider:'kimi', model:'kimi-k2' },
    { role:'critic',  prompt:'反向审',provider:'anthropic', model:'claude-sonnet-4' },
    { role:'verify',  prompt:'跑测',  provider:'openai',    model:'gpt-4o-mini' },
  ],
  judge: { provider:'glm', model:'glm-4.5' },
});
```

router 不做策略推荐——主 agent 自己决定（system prompt 中给出建议范本）。

## 失败传播

- 单个 sub-agent 失败 → 不中断其他；其结果 ok=false；
- judge 收到 ok=false 也照常聚合（"该角度未给出有效结论"）；
- 全局 budget 超限 → cancelAll；返回 stopReason='budgetExceeded'。

## 进度上报

`progress.ts` 提供事件总线：

```ts
swarmBus.on('progress', (e: { id: string; phase: string; tokensOut: number }) => ...)
swarmBus.on('lifecycle', (e: { id: string; status: AgentStatus }) => ...)
```

UI（步骤 22）订阅并实时渲染。

## 验收标准

- dispatch 4 个 prompts × 不同 provider，全部并行执行；
- parallelism=2 时实际同时运行不超 2 个；
- 主 agent budgetUSD=$0.05 时较快达到熔断（3-5 个 sub agent 即停）；
- 取消 dispatch 整体 → 所有未完成 sub agent 状态变 cancelled。

## 参考源

- `cc-haha/src/coordinator/`、`tools/AgentTool/`、`utils/swarm/`

## 风险

- 100 个 spawn 的 fan-out 风险（fd / 内存）→ pool 限制 + 全局并发上限；HTTP keepalive。
