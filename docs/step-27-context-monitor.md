# Step 27 — Context Monitor（SCW 触发器 + 自适应阈值）

**Phase**: H | **依赖**: 17,26 | **可并行**: ❌（H 阶段第一步） | **估时**: 4h

## 目标

实现 **SCW** 创新的第一半：实时监控当前会话 token 用量，按 *自适应阈值*
触发 *软提示* 与 *自动 checkpoint*，为 step-28 的重建做准备。

## 产物

```
src/context/
├── monitor.ts            # 主监控器
├── tokenizer.ts          # 跨 provider 估算（共享）
├── thresholds.ts         # 阈值计算
└── index.ts
```

## 自适应阈值

```ts
import { CAPS } from '../providers/capabilities';

export interface ContextThresholds {
  ctxWindow: number;
  soft: number;     // 默认 ctx * 0.75
  hard: number;     // 默认 ctx * 0.90
  reserve: number;  // 输出预留（默认 4000）
}

export function thresholds(model: string, modelProvider: ProviderId, cfg: ChovyConfig): ContextThresholds {
  const ctx = CAPS[modelProvider].contextWindow;
  return {
    ctxWindow: ctx,
    soft: Math.floor(ctx * cfg.context.softRatio),
    hard: Math.floor(ctx * cfg.context.hardRatio),
    reserve: cfg.context.reserveTokens,
  };
}
```

可由 `CHOVY_CTX_SOFT_RATIO` / `CHOVY_CTX_HARD_RATIO` 临时覆盖。

## Token 估算（不强依赖 tiktoken）

```ts
// tokenizer.ts
export interface TokenEstimator {
  countMessages(msgs: ChatMessage[]): number;
  countString(s: string): number;
}
// 默认实现：4 chars / token（保守 1.2 倍系数）
// gpt 系：可选 tiktoken-light（按需 lazy import）
// claude 系：用 anthropic.token-counter API（仅当 feature('exact_count') 开启）
```

## Monitor API

```ts
export interface MonitorState {
  total: number;          // estimated input tokens of next call
  effective: ChatMessage[];
  thresholds: ContextThresholds;
  level: 'fresh' | 'soft' | 'hard';
}

export class ContextMonitor {
  constructor(deps: { checkpoints: CheckpointCoordinator; ... });
  inspect(messages: ChatMessage[], systemBytes: number, model: string): MonitorState;
  onLevelChange(cb: (state: MonitorState) => void): Unsubscribe;
}
```

QueryEngine 在每轮 *调 provider 之前* 调用 `monitor.inspect()`，并根据 level 决定行为（在 step-28 中详细）：

- `fresh` → 正常进入；
- `soft` → *提示主 agent*：在 system prompt 中追加一段 "<context-pressure level='soft' usage='82%'/>"，并触发 checkpoint coordinator（不阻塞）；
- `hard` → 进入 step-28 的 rebuild 流程。

## "提示主 agent" 段（soft）

```
<context-pressure level="soft" used="82%" remaining_tokens="22000">
你的上下文使用接近 75%。请尝试：
- 精炼回答；
- 完成手头的子步骤后通过 TodoWrite 收尾；
- 调用 dispatch 时降低 prompts 数量。
checkpoint 已自动保存。
</context-pressure>
```

## 自动 checkpoint 触发

```
if level transitions from 'fresh' → 'soft'
   call checkpoints.maybeCheckpoint('soft-threshold')
if level === 'soft' && noCheckpointInLast(60s)
   call checkpoints.maybeCheckpoint('soft-debounce')
```

由 step-26 的 CheckpointCoordinator 真正去派 sub agent 写。

## 事件

```ts
telemetry.emit({ type: 'context.threshold', level, tokens: state.total });
```

UI 的 HeaderBar 实时显示 `ctx 67% / soft 75% / hard 90%`。

## 验收标准

- 模拟长对话 → soft 触发 checkpoint 子 agent；
- HeaderBar 数字与实际估算误差 < 5%；
- 切换 model（不同 ctx 窗口）阈值自动更新；
- 关闭 monitor（CHOVY_CTX_DISABLE=1）时 QueryEngine 仍正常运行（只是不再自动 checkpoint）。

## 参考源

- `cc-haha/src/services/compact/autoCompact.ts`、`utils/contextWindow.ts`

## 风险

- 估算误差导致 hard 早触发 → reserve 默认偏保守（4k）；提供调参。
