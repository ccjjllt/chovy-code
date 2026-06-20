# Step 23 — Goal Loop（`/goal` 长程任务）

**Phase**: F | **依赖**: 16,18,13 | **可并行**: ❌ | **估时**: 6h

## 目标

实现 codex 风格的 `/goal <objective>`：让 chovy-code **持续迭代直到目标达成**。
基于"Stop-hook + 收敛判据"实现，不引入额外调度器。

## 产物

```
src/goals/
├── goalState.ts       # 目标对象 + 持久化
├── goalHook.ts        # Stop hook 注入（让 agent 不自动停下）
├── convergence.ts     # 达成判据
├── iterations.ts      # 单轮迭代逻辑
├── checkpoint.ts      # 与 step-26 协作
└── index.ts
src/cli/components/GoalPanel.tsx
src/cli/slashCommands/goal.ts
```

## 数据结构

```ts
export interface GoalState {
  id: string;
  threadId: string;
  objective: string;       // 原始目标
  rubric?: string;         // 收敛判据描述（用户提供）
  createdAt: number;
  updatedAt: number;
  rounds: number;
  maxRounds: number;       // 默认 25
  status: 'active' | 'paused' | 'achieved' | 'failed' | 'cancelled';
  history: Array<{
    round: number;
    summary: string;
    converged: boolean;
    cost: number;
    ts: number;
  }>;
  budgetUSD: number;       // 总成本上限，默认 $5
  totalCostUSD: number;
}
```

持久化：`~/.chovy/projects/<id>/goals/<goal-id>.json`。
活跃目标的 `progress.md` 写到 `tasks/<goal-id>/progress.md`，给 step-26 的 checkpoint writer 引用。

## 斜杠命令

```
/goal <objective>           # 设置目标
/goal status                # 查看当前
/goal pause | resume
/goal complete              # 手动标记达成（用户超越 AI 判定）
/goal clear                 # 清除目标
/goal --rubric "<rule>"     # 追加判据（如："bun typecheck 通过 且 测试全绿"）
```

## Stop-hook 注入

借鉴 cc-haha 的 goalHook 思路：

```
当 agent 想要"自然结束本轮对话"（即没有 tool_use、给出最终答案）时：
  Stop-hook 拦截：
    convergence.evaluate(objective, transcript) → { converged, evidence }
    若 converged → 放行（让 agent 真停止）；
    否则 → 注入新的 user message："目标尚未达成。判据未满足：[reasons]。请继续"，
          继续下一轮 query。
```

Hook 写到 settings.json 中，作为 *managed hook*，不会泄漏到用户配置。

## 收敛判据（convergence.ts）

支持三种模式：

```ts
export type ConvergenceMode = 'rubric' | 'command' | 'hybrid';

export interface RubricBased { mode: 'rubric'; rubric: string; }
export interface CommandBased { mode: 'command'; cmd: string; expectedExitCode?: number; }
export interface Hybrid { mode: 'hybrid'; rubric: string; cmd: string; }
```

- `rubric`：调小模型按 rubric 评估 transcript（gpt-4o-mini 等）；
- `command`：跑命令（如 `bun typecheck`），exit=0 算达成；
- `hybrid`：必须两者皆达成。

设置默认值：

- `objective` 包含 "compile/typecheck/build/test pass" → 自动推断 cmd；
- 否则用 rubric。

## 单轮迭代

```
loop while goal.status === 'active' && goal.rounds < goal.maxRounds:
  beforeRound: hooks.run('GoalIteration', { goal, round })
  result = await queryEngine.run({ messages, ... })
  goal.rounds++
  goal.totalCostUSD += result.costUSD

  if result.stopReason === 'cancelled' → status='cancelled'; break
  if budget exceeded → status='failed'; break

  conv = await convergence.evaluate(goal, allMessages, result)
  goal.history.push({ round, summary, converged: conv.ok, ... })

  if conv.ok → status='achieved'; break
  else:
    inject(`<goal-not-achieved/>${conv.reasons.join('; ')}` as user message)
    每 N 轮触发 checkpoint-writer（step-26）
```

## 与 swarm 的协作

主 agent 在 goal-loop 中可以发起 dispatch；子 agent 完成后结果回写给主，主再考虑是否达成。
GoalPanel 显示当前轮数 / 子 agent 数 / 总成本。

## UI

```
┌─ /goal: 让 chovy-code 仓库通过 typecheck ───────────────────────┐
│ round 4/25     budget $0.42/$5.00     status: active            │
│ rubric: bun typecheck 退出码 = 0                                 │
│ last:   修复了 src/agent/agent.ts 中的类型错误（剩 3 处）         │
│ [p] pause  [c] cancel  [Enter] details                          │
└──────────────────────────────────────────────────────────────────┘
```

## 验收标准

- `/goal "添加 README 章节 'Goal Loop'"` → agent 自主修改并达成；
- `/goal "bun typecheck 通过"` → 反复 edit 直到 cmd exit=0；
- 达到 maxRounds 自动停 + status='failed'；
- pause 后 resume 可继续。

## 参考源

- `cc-haha/src/goals/goalState.ts`
- codex 公开博客中的 goal loop 描述

## 风险

- 死循环（agent 反复"修复"但 rubric 永远不过）→ maxRounds + 连续 N 轮无新文件改动则降级为 ask 用户。
