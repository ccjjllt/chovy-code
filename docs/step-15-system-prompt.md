# Step 15 — System Prompt（5 层优先级 + 静态/动态分区 + PSF）

**Phase**: D | **依赖**: 01 | **可并行**: ✅（与 12/13/14 并行可写） | **估时**: 4h

## 目标

把 system prompt 抽象为 **5 层组合 + 静态/动态分区**，并实现 **PSF（Prompt Shape Fingerprint）**——
为 chovy-code 的多 provider 场景提供通用的"prompt 稳定性"诊断。

## 产物

```
src/prompts/
├── default.ts          # chovy-code 主 system prompt（≈400 行）
├── boundary.ts         # SYSTEM_PROMPT_DYNAMIC_BOUNDARY 标记 + 分区
├── builders.ts         # buildEffectiveSystemPrompt（5 层组装）
├── fingerprint.ts      # PSF 实现
├── snippets.ts         # 公用片段（cwd/env/memory 段）
└── index.ts
```

## 5 层优先级

```ts
export type SystemPromptLayer =
  | 'override'      // 0：被 loop / coordinator 等覆盖一切
  | 'coordinator'   // 1：多 agent 协调专属
  | 'agent'         // 2：子 agent 自定义
  | 'custom'        // 3：用户 --system-prompt 注入
  | 'default';      // 4：默认 prompt + Append

export interface BuildOptions {
  override?: string;
  coordinator?: string;
  agent?: { role: AgentRole; prompt: string; omitMemory?: boolean };
  custom?: string;
  defaultAppend?: string;
  context: SystemContext;   // cwd, gitStatus, model, mcpList, ...
}

export function buildEffectiveSystemPrompt(opts: BuildOptions): EffectivePrompt;

export interface EffectivePrompt {
  text: string;             // 完整字符串
  staticHash: number;       // 静态部分指纹
  dynamicHash: number;      // 动态部分指纹
  segments: Array<{ name: string; bytes: number; from: SystemPromptLayer }>;
}
```

## 静态/动态分区

`boundary.ts` 维护一个常量 `CHOVY_PROMPT_DYNAMIC_BOUNDARY = '<!--chovy:dynamic-->'`。
默认 prompt 模板里此标记之前的内容必须是稳定的（身份介绍、工具规范、安全规范、风格、效率要求）；之后是动态：

- 当前工作目录与 git 状态；
- MEMORY.md 摘要 / 注入项；
- model 信息与知识截止；
- 已加载技能列表；
- 已加载 MCP 服务（future）；
- ContextBudget 使用情况（自报告，让模型知道剩余空间）。

> 我们**保留** Anthropic prompt cache 的潜在受益（boundary 之前可被 cache_control 标记），
> 但**不要求**所有 provider 都有 cache 机制；其他 provider 受益于"稳定 prefix → 不变的输出风格"。

## 默认 system prompt 关键内容

主要主题（与 cc-haha 一致 + chovy-code 自有约束）：

- chovy-code 身份与目标（多 provider 编码代理）；
- 工具优先级（Read 不用 cat / Edit 不用 sed / Glob 不用 find）；
- 代码修改准则（不擅自重构）；
- 安全（reversibility / blast radius）；
- Git 安全（不改 git config / 不 force push 除非用户明确要求 / 不 --no-verify）；
- 输出风格（直奔主题 / 不冒号 / 简洁）；
- chovy 专属（创新点提醒）：
  - "你可以用 `dispatch` 工具一次派发多个子 agent"
  - "你可以用 `/goal` 维持长程任务；不达成不停止"
  - "你的记忆来自 MEMORY.md / checkpoints / progress / notes —— 已自动注入"

## PSF — Prompt Shape Fingerprint

```ts
// fingerprint.ts
export interface PromptShape {
  modelId: string;
  staticHash: number;
  dynamicHash: number;
  toolsHash: number;
  toolNames: string[];
  perToolHash: Record<string, number>;
  systemBytes: number;
  injectedSegments: string[];
  ts: number;
}

export function computeShape(prompt: EffectivePrompt, tools: DescribedTool[]): PromptShape;
export function diffShape(a: PromptShape, b: PromptShape): ShapeDiff;
```

每次 query 写一行到 telemetry。`chovy prompt diff <session>` 命令对比两次 shape。

## 验收标准

- `buildEffectiveSystemPrompt` 在 plan 模式下追加"plan 模式提示"段；
- override 层存在时其它 4 层全部忽略；
- 同一 cwd 下两次启动的 staticHash 相同（关键：稳定性）；
- 工具描述变化导致 perToolHash 改变 → 在 telemetry 中可见。

## 参考源

- `cc-haha/src/constants/prompts.ts`、`utils/systemPrompt.ts`、`services/api/promptCacheBreakDetection.ts`

## 风险

- 默认 prompt 过长 → 控制在 ~3000 tokens；多余内容 lazy 加载（如 MCP 列表）。
