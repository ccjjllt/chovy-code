# Step 38 — 5 个吉祥物状态机（idle/work/think/done/error）

**Phase**: K | **依赖**: 37 | **估时**: 4h

## 目标

把 5 个 GIF 文件挂到 chovy-code 的 5 个内部状态上，通过 `CompanionState` 切换让吉祥物
"知道" agent 在做什么——idle 等输入、work 跑工具、think 流式 token、done 刚完成、error 出错。

## 产物

```
src/companion/
├── stateMachine.ts        # CompanionState union + 状态转移规则
├── stateBus.ts            # process-internal pub/sub（与 swarmBus 同模式）
└── skin.ts                # CompanionState → gifPath 解析（含用户自定义 skin）
```

## 实现要点

### 1. CompanionState（B9 冻结）

```ts
// src/companion/stateMachine.ts
export type CompanionState = "idle" | "work" | "think" | "done" | "error";
// 联合扩展只追加成员（如 "petting"），不替换既有
```

### 2. 状态转移规则

| 触发 | 当前 → 目标 | 触发位置 |
|---|---|---|
| REPL 启动 | * → `idle` | repl.tsx 初始化 |
| `runAgent` 开始 | `idle`/`done`/`error` → `work` | repl.tsx send() |
| 流式 token 到达且 5s 内无工具调用 | `work` → `think` | onToken 累计 |
| 工具调用开始 | `think` → `work` | onToolCall |
| `runAgent` 成功收尾 | `work`/`think` → `done` | send() finally |
| 错误 / abort | * → `error` | catch |
| `done` 持续 5s | `done` → `idle` | setTimeout |
| `error` 持续 8s | `error` → `idle` | setTimeout |
| `/buddy pet` | * → `petting` (后续状态) | step-40 |

```ts
export interface StateMachine {
  current(): CompanionState;
  setState(s: CompanionState, reason?: string): void;
  onChange(fn: (s: CompanionState, prev: CompanionState) => void): () => void;
  dispose(): void;
}
export function createStateMachine(): StateMachine;
```

实现是个普通 EventEmitter + setTimeout 自动衰减；进程内单例 via `getCompanionStateMachine()`。

### 3. stateBus（独立于 stateMachine）

跟 `agent/swarmBus.ts` 同模式：UI-only pub/sub，不触发 telemetry，不持久化。
为什么单独一个 bus 而不是 stateMachine：状态机管「current state」（一次只一个）；
stateBus 还广播额外事件（如 `bubble` quip / `pet` 触发），UI 多消费方各自订阅。

```ts
// src/companion/stateBus.ts
export interface CompanionEvent {
  type: "state" | "bubble" | "pet" | "skin";
  // 字段按 type 分类...
}
export const companionBus = createBus<CompanionEvent>();
```

### 4. skin.ts — state → gifPath 解析

```ts
// 默认 skin
const DEFAULT_SKIN: Record<CompanionState, string> = {
  idle:  "gif/2026-06-12_012827.GIF",
  work:  "gif/2026-06-12_012830.GIF",
  think: "gif/2026-06-12_012832.GIF",
  done:  "gif/2026-06-12_012835.GIF",
  error: "gif/2026-06-12_234328.GIF",
};

export function resolveGifPath(state: CompanionState, skinName: string, cwd: string): string {
  if (skinName === "default") return path.resolve(cwd, DEFAULT_SKIN[state]);
  // 用户自定义 skin: ~/.chovy/skins/<name>/<state>.gif
  const userPath = path.join(chovyHome(), "skins", skinName, `${state}.gif`);
  return userPath;   // 不存在则 player 走 ASCII fallback
}
```

### 5. 与 runAgent 集成

```tsx
// src/cli/repl.tsx 内部（最小入侵）：
const sm = getCompanionStateMachine();

useEffect(() => () => sm.dispose(), []);

// send() 内：
sm.setState("work", "send-start");
const final = await runAgent(t, {
  ...,
  onToken: (delta) => {
    /* 既有 */
    if (sm.current() === "work" && noToolFor5s()) sm.setState("think", "stream-only");
  },
  onToolCall: (name) => {
    /* 既有 */
    sm.setState("work", `tool=${name}`);
  },
});
sm.setState("done", "send-finally");      // setTimeout 5s 自动 → idle

// catch:
sm.setState("error", err.message);        // setTimeout 8s 自动 → idle
```

> **不**直接读 `busy` state 推导——state machine 自管，避免双源。busy state 仍由 repl 持有，吉祥物状态独立。

## 接口冻结 / 不变量

- `CompanionState` 联合冻结（B9）；扩展只追加。
- 自动衰减时长（done=5s, error=8s）写在常量，不进 config（避免用户调成 0 引发抖动）。
- state 转移**幂等**：同 state setState 是 no-op（不触发 onChange）。
- stateMachine 是进程内单例；测试用 `_resetStateMachineForTesting()` 清空。

## 验收标准

- `bun run typecheck` 通过；
- `scripts/smoke-step38.ts`：模拟 send() 流程，状态序列为 `idle → work → done → idle`（5s 后）；
- error path：抛错 → state=error，8s 后回 idle；
- 跑 chovy 真实运行：发消息时吉祥物从 `idle` GIF 切到 `work` GIF（视觉验证）；
- 同一 state 重复 setState 不触发 onChange callback（用 spy 验证调用次数）。

## 风险

- **think 误判**：流式 token 到达但很快又触发工具 → 可能有 100ms 闪 think。延迟切 think 用 5s 窗口（spec 上文）—— 工具调用通常 < 5s 触发，所以正常情况下 think **几乎不会出现**，是低频状态。
- **setTimeout 累积**：连续多次 `setState("done")` 会建多个 timer；用 ref 记录当前 timer，setState 时 clearTimeout 旧 timer。
- **状态泄漏到子 agent**：吉祥物只反映 main agent 状态；SwarmR fan-out 不切吉祥物（避免抖动）。
