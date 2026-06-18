# Step 03 — Logger & Local Telemetry Sink

**Phase**: A | **依赖**: 无 | **可并行**: ✅ | **估时**: 2h

## 目标

把现有 `src/logger/logger.ts` 升级为支持结构化日志 + 本地 telemetry sink。
不上报远端任何数据；所有事件落到 `~/.chovy/telemetry/*.jsonl`。

## 产物

```
src/logger/
├── logger.ts          # 重构：分级 + 结构化
├── format.ts          # 新：人类可读 + JSON 双格式
└── index.ts
src/telemetry/
├── localSink.ts       # 新：写 JSONL
└── events.ts          # 新：事件类型
```

## 实现要点

### 1. Logger API

```ts
export interface Logger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(...): void;
  info(...): void;
  warn(...): void;
  error(msgOrErr: string | Error, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
  setLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'): void;
}
```

- TTY 输出彩色（chalk 不引入；用 ANSI 直写）；
- 非 TTY / `CHOVY_LOG_JSON=1` 输出 NDJSON；
- `child('queryEngine')` 自动添加 `scope` 字段。

### 2. 本地 telemetry sink

```ts
// src/telemetry/events.ts
export type TelemetryEvent =
  | { type: 'agent.start'; agentId: string; role: AgentRole; ts: number }
  | { type: 'agent.end'; agentId: string; status: string; costUSD: number; ts: number }
  | { type: 'tool.call'; tool: string; ok: boolean; durMs: number; ts: number }
  | { type: 'context.threshold'; level: 'soft' | 'hard'; tokens: number; ts: number }
  | { type: 'goal.iteration'; round: number; converged: boolean; ts: number }
  | { type: 'memory.injection'; bytes: number; entries: number; ts: number }
  | { type: 'swarm.dispatch'; n: number; parallelism: number; ts: number }
  | { type: 'prompt.shape'; shape: PromptShape; ts: number };
```

按天滚动文件：`~/.chovy/telemetry/2026-06-18.jsonl`。

### 3. CLI 工具

后续 `chovy log tail`、`chovy log diff`（非本步骤）。本步骤只保证写入正确。

## 验收标准

- `CHOVY_LOG_JSON=1 chovy --verbose "hi"` 输出 NDJSON；
- `~/.chovy/telemetry/<date>.jsonl` 出现 `agent.start` / `agent.end` 两行；
- 切换日志级别立即生效，无需重启。

## 参考源

- `cc-haha/src/utils/logger.ts`、`cc-haha/src/services/analytics/`（仅本地实现）

## 风险

- 高频写入磁盘性能 → buffered append（每 100ms flush）。

## 验收追补（2026-06-18）

- Logger 必须识别 `ChovyError` 并输出规范形态：`chovy.error: <CODE> <message>`。
- `ChovyError` 属于业务错误，CLI/NDJSON 输出不应附带 stack；普通内部异常仍可附带 stack 便于调试。
