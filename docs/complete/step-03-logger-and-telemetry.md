# Step 03 完成报告 — Logger & Local Telemetry Sink

- **Phase**: A（Foundation）
- **依赖**: 无（B1–B4 屏障无关）
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-03-logger-and-telemetry.md`](../step-03-logger-and-telemetry.md)
- **关联创新**: 为 SCW（`context.threshold`）/ SwarmR（`swarm.dispatch`）/ Goal Loop（`goal.iteration`）/ TMT（`memory.injection`）/ PSF（`prompt.shape`）预埋本地观测通道；**无任何远端上报**（遵守 AGENTS.md §5）。

---

## 1. 目标回顾

把现有 `src/logger/logger.ts` 升级为支持结构化日志 + 本地 telemetry sink；
所有事件落到 `~/.chovy/telemetry/*.jsonl`，按天滚动；不上报远端。

## 2. 产物清单

### 2.1 新建文件

| 路径 | 行数（约） | 作用 |
|---|---|---|
| `src/logger/format.ts` | 90 | `Level` 枚举、`LEVEL_ORDER`、`formatHuman`（ANSI 直写，无 chalk）、`formatJson`（NDJSON）、`safeStringify`（防循环引用 + BigInt） |
| `src/telemetry/events.ts` | 50 | `TelemetryEvent` 8 类联合 + `TelemetryEventInput`（`Omit<_, 'ts'>` 由 sink 自动填充）+ 占位 `AgentRole` / `PromptShape` |
| `src/telemetry/localSink.ts` | 165 | `FileTelemetrySink`（缓冲 + 按天滚动 + `beforeExit`/`exit` 兜底）+ `NullSink`（`CHOVY_TELEMETRY=0`）+ 工厂 / 单例 / 全局 emitter |
| `src/telemetry/index.ts` | 15 | barrel 导出 |
| `docs/complete/step-03-logger-and-telemetry.md` | 本文件 | 完成报告 |

### 2.2 改动文件

| 路径 | 改动要点 |
|---|---|
| `src/logger/logger.ts` | 重构为 `Logger` 接口：6 级（trace/debug/info/warn/error/silent）+ `child(scope)` + `error(Error)` 自动抽 stack + 共享 `core` 状态让 child 跟随 `setLevel` |
| `src/logger/index.ts` | 同步导出 `Logger` 类型、`setJsonOutput`、`currentLevel` |
| `src/agent/agent.ts` | 发射 `agent.start` / `agent.end`（`finally` 块保证 end 必发）/ `tool.call`（成功 / unknown tool / schema 失败 / 抛错四态）；`await sink.flush()` 让短命 CLI 落盘 |
| `src/cli/index.tsx` | `--verbose` 仅在 `CHOVY_LOG_LEVEL` 未设置时降为 `debug`，不覆盖用户的 trace/silent 偏好 |

### 2.3 未触碰的文件（避免越界）

- `bin/chovy.js`、`bin/chovy.js.map`（AGENTS.md §9 红线 — 构建产物）
- 任何 `docs/step-XX-*.md`（接口冻结点）
- `package.json`（未引入新依赖）

---

## 3. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 颜色用 ANSI 直写而非引入 `chalk` | step-03 文档明确 "chalk 不引入"；保持依赖最小 |
| D2 | TTY 自动判定 + `CHOVY_LOG_JSON=1` 强制 JSON | 满足验收标准 1；CI / pipe 场景默认 NDJSON |
| D3 | `core` 状态对象 + closure-based logger 工厂 | child logger 自动跟随 `setLevel` 即时切换，无需重建实例 |
| D4 | `Error` 自动抽 `name/message/stack` | 让 `logger.error(err)` 在两种格式下都可读 |
| D5 | 100 ms 缓冲 `setInterval(...).unref()` | step-03 风险段要求；`.unref()` 让一次性 CLI 不被定时器拖住退出 |
| D6 | `beforeExit` + `exit` 双重 flush 钩子 | 兜底；同时 `runAgent.finally` 显式 `await flush()` 应对极短的同步退出路径 |
| D7 | 写失败时回退队列（上限 1000） | "telemetry 失败不应崩溃 agent"，但避免内存无限增长 |
| D8 | `localDate(new Date(ev.ts))` 在 flush 时分组 | 防止跨午夜时一批事件被错误地写到上一天文件 |
| D9 | `AgentRole` / `PromptShape` 用 `(string & {})` 与占位接口 | 让后续 step-15 / step-19 可平滑替换，不破坏当前 typecheck |
| D10 | `agent.ts` 内联 `makeAgentId()` + `costUSD: 0` | step-18 / step-16 才会接入正式生命周期与 cost tracker；用 TODO 标记 |

---

## 4. 验收对照

| 标准 | 状态 | 证据 |
|---|---|---|
| `CHOVY_LOG_JSON=1 chovy --verbose "hi"` 输出 NDJSON | ✅ | 实测 `bun -e` 下输出 `{"t":...,"level":"info","scope":"queryEngine","msg":"hi","round":1}` 等 NDJSON 行 |
| `~/.chovy/telemetry/<date>.jsonl` 出现 `agent.start` / `agent.end` 两行 | ✅ | `C:\Users\N176\.chovy\telemetry\2026-06-18.jsonl` 实测两行已落盘 |
| 切换日志级别立即生效，无需重启 | ✅ | `setLevel('warn')` → info 被过滤；改回 `'trace'` → trace/debug 立刻可见 |
| `bun run typecheck` 通过 | ✅ | `tsc --noEmit` 无错 |
| 单文件 ≤ 600 行（AGENTS.md §8） | ✅ | 最长 `localSink.ts` 约 165 行 |
| 不引入新依赖（AGENTS.md §8） | ✅ | `package.json` 未变 |
| 不破坏屏障接口（B1–B4） | ✅ | 仅新增 + 内部重构；未改 `Tool` / `Provider` / `QueryEngine` 等冻结契约 |

---

## 5. 风险登记 & 后续 TODO

代码内显式打了 4 个 TODO 标记，留给后续步骤接管：

| 位置 | 标记 | 计划接手步骤 |
|---|---|---|
| `src/telemetry/localSink.ts` `chovyHome()` | TODO step-04 | step-04 落 `src/fs/home.ts` 后切 `paths.chovyHome()` |
| `src/telemetry/localSink.ts` 直接 `node:fs` 调用 | TODO step-04 | step-04 落 `safeFs` 后路由 |
| `src/telemetry/events.ts` `AgentRole` / `PromptShape` | TODO step-15 / step-19 | step-15 落 `prompts/fingerprint.ts`、step-19 落 `agent/lifecycle.ts` 后替换 |
| `src/agent/agent.ts` `costUSD = 0` + `makeAgentId()` | TODO step-16 / step-18 | step-16 由 `costTracker` 提供、step-18 由 `SubAgentHandle.id` 取代 |

**已知潜在风险**

- **R-step03-1**: 目前直接读写文件系统（`node:fs`），跨平台风险（如只读 `~`）会导致 `flushSync` 走异常分支 → 已用 `try/catch` + 回退队列 + `logger.debug` 静默处理，不会冒泡。
- **R-step03-2**: 100 ms 缓冲在极端高频（>10k events/s）下队列会膨胀；当前不限速，靠 `.unref()` 与 1000 长度的回退上限兜底。后续若 SwarmR 100 子 agent 实际超频再引入背压。
- **R-step03-3**: `--verbose` 与 `CHOVY_LOG_LEVEL` 并存时优先级行为已写注释；如果用户期望相反，需 step-05 在 CLI 文档中明确。

---

## 6. 屏障与冻结点确认

| 屏障 / 冻结接口 | 本步是否触碰 | 备注 |
|---|---|---|
| B1: Tool 协议 v2（step-06） | ❌ 未触 | 仅在 `agent.ts` 调用现有 `tool.run`；接口未改 |
| B2: QueryEngine（step-16） | ❌ 未触 | 仍是占位简易 agent loop |
| B3: Provider 真实接线（step-17） | ❌ 未触 | 未改 `Provider.complete/stream` |
| B4: Memory store（step-24） | ❌ 未触 | telemetry 不依赖 memory |
| `Logger` 接口 | ✅ 本步定义 | 后续 child / scope / level 用法已稳定，不应破坏 |
| `TelemetryEvent` 联合 | ✅ 本步定义 | 后续若新增类型，仅追加 union 成员；现有成员字段不动 |

---

## 7. 复盘与建议

1. **顺手没改未要求的代码** ✅：除 `agent.ts` 与 `cli/index.tsx` 必要的发射点 / 环境变量适配，其它文件未碰。
2. **实施顺序合理**：先 format → logger → events → sink → agent 接入 → cli 适配 → typecheck → 冒烟。每步独立验证。
3. **给后续步骤的提示**：
   - step-04 完成后，请把 `localSink.ts` 顶部 `chovyHome()` 与 `mkdirSync/appendFileSync` 替换为 `safeFs` API；`existsSync` 也应统一走 `safeFs`。
   - step-16 的 `QueryEngine` 接管 agent loop 时，请把 `agent.start` / `agent.end` / `tool.call` 三处发射点搬过去，并以 `costTracker.totalUSD()` 替换 `costUSD: 0`。
   - step-19 落 `AgentRole` 时，请把 `events.ts` 的占位 union 改为 `import type { AgentRole } from '../agent/lifecycle.js'`。
   - step-22 的 Ink UI 想可视化进度，可以直接订阅 `getTelemetrySink()` 的事件流——为此可考虑给 sink 增加 `onEmit` 钩子（本步未加，留给真有需要时再加）。

---

**结论**: step-03 全部产物已落地，3 条验收标准全部通过，typecheck 通过，未破坏任何屏障接口与红线。可以开始 step-04（FS abstraction + ~/.chovy 主目录）。
