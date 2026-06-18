# Step 21 — Judge Aggregator（结构化裁判模型）

**Phase**: E | **依赖**: 20 | **可并行**: ✅（与 22 并行） | **估时**: 4h

## 目标

实现 SwarmR 的"裁判模型"：把多个 sub agent 的结果按 *zod 强约束 schema* 聚合，给出结构化判定。

## 产物

```
src/swarm/
├── judge.ts            # judge 主入口
├── schemas.ts          # 4 种内置 schema
└── prompts/
    ├── consensus.txt
    ├── compare.txt
    ├── rank.txt
    └── meta.txt
```

## 内置 schema

```ts
// schemas.ts
export const ConsensusSchema = z.object({
  agreement: z.enum(['strong','weak','split','conflict']),
  evidence: z.array(z.object({
    fromAgentId: z.string(),
    excerpt: z.string().max(500),
    weight: z.number().min(0).max(1),
  })),
  risks: z.array(z.string()).max(10),
  unresolved: z.array(z.string()).max(10),
  final_answer: z.string(),
  confidence: z.number().min(0).max(1),
});

export const CompareSchema = z.object({
  pairs: z.array(z.object({
    a: z.string(), b: z.string(),
    diff: z.string(), winner: z.enum(['a','b','tie']),
  })),
  recommendation: z.string(),
});

export const RankSchema = z.object({
  ranking: z.array(z.object({
    agentId: z.string(), score: z.number().min(0).max(10), reason: z.string(),
  })),
  topPick: z.string(),
});

export const CustomMeta = (s: z.ZodTypeAny) => z.object({ items: z.array(s) });
```

## 默认 judge provider

按可用性 fallback：

```
Kimi-K2 (256k) → GLM-4.5 (128k) → DeepSeek-V3 (128k) → Gemini-1.5-pro (1M)
                                                     → Claude Sonnet 4 (200k)
```

可由 `dispatch.judge.provider/model` 覆盖。
**默认偏好长上下文模型**——因为聚合输入 = N 个 sub agent 的完整 content。

## 流程

```
1. 拼接输入：把 N 个结果包装为
   <agent id="..." role="..." status="..."><content>...</content></agent>
2. 加上 schema 提示词（"请输出符合以下 zod 结构的 JSON"）；
3. provider 支持 json-mode 时强制 JSON；否则仅约束 + 后处理 tryFixJSON；
4. 用 zod parse；失败 → 重试一次（最多 1 次自我修复）；
5. 仍失败 → 降级返回 raw text + ok=false。
```

## 系统 prompt 模板（consensus）

```
你是裁判模型。输入是 N 个子智能体（异构 provider）对同一问题的回答。
请按以下规则输出：
1. agreement: 子结论是否一致（strong/weak/split/conflict）；
2. evidence: 引用每个 agent 的关键句作为依据；
3. risks: 子结论中的潜在风险；
4. unresolved: 仍未解决的问题；
5. final_answer: 你的整合答案，假设你必须给用户一个明确回复；
6. confidence: 0–1 的置信度。

严格输出 JSON，不要 prose。
```

## 自我修复

```ts
async function callWithRepair(provider, prompt, schema, attempt = 0): Promise<unknown> {
  const raw = await provider.complete({ ... });
  const fixed = tryFixJSON(raw.content);   // 去除 ``` 包裹 / 截断尾部 / ...
  const parsed = schema.safeParse(fixed);
  if (parsed.success) return parsed.data;
  if (attempt >= 1) throw new ChovyError('INTERNAL', 'Judge schema parse failed');
  return callWithRepair(provider, repairPrompt(raw, parsed.error), schema, attempt+1);
}
```

## 输出形式

```ts
export interface JudgedAggregate<T = unknown> {
  schemaName: 'consensus' | 'compare' | 'rank' | 'custom';
  data: T;            // zod-parsed
  rawText: string;    // 给调试用
  costUSD: number;
  modelUsed: string;
}
```

主 agent 收到后会被 dispatch 工具直接编入 `tool_result`，结构清晰可机器读。

## 验收标准

- 3 个 sub agent（disagree）→ Consensus 输出 split 且 evidence 数=3；
- 全员 ok=false → judge 仍能返回 conflict + unresolved；
- json-mode 可用时 100% schema parse 成功；
- 不可用时通过 tryFixJSON 兜底 ≥ 95% 成功。

## 参考源

- 无直接对应（chovy-code 创新）；可借鉴常见 LLM-as-judge 论文做 prompt 模板。

## 风险

- 大 N 时 judge 输入超 ctx → 自动对每个 agent content 截断到 ≤ 4 KB（首尾保留）+ 在 prompt 中说明已截断。
