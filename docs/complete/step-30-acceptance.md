# Step-30 Acceptance — Integration & E2E

**Phase**: I | **依赖**: step-23, step-28, step-29 | **状态**: ✅ Complete

验收日期：2026-06-19

## 交付物

| 路径 | 说明 |
|---|---|
| `docs/USAGE.md` | 终端用户使用手册 |
| `docs/DEVELOPING.md` | 开发者贡献与验证指南 |
| `docs/KNOWN-LIMITATIONS.md` | 已知限制清单 |
| `scripts/demo.ts` | 跨平台离线 demo，演示 ATP / SwarmR / TMT / SCW / CSG |
| `scripts/demo.sh` | POSIX wrapper，委托 `bun run demo` |
| `scripts/smoke.ts` | 总集成 smoke，默认 mock provider |
| `scripts/bench/tool-budget.bench.ts` | ATP 描述预算 bench |
| `scripts/bench/memory-fts.bench.ts` | Memory FTS5 bench |
| `scripts/bench/swarm-100.bench.ts` | Swarm 100 mocked agents bench |
| `scripts/bench/context-rebuild.bench.ts` | Context rebuild bench |
| `src/memory/{injection,ranker,selector,promptSegment}.ts` | step-25/30 TMT prompt 注入 glue |
| `src/engine/memoryHook.ts` | QueryEngine ↔ Memory 注入入口 |

## 接线检查

| 项 | 结果 |
|---|---|
| QueryEngine ↔ Permission | 仍经 `executeToolCall` / `runPreflight` 6 层权限 |
| QueryEngine ↔ Hooks | SessionStart/PreApiCall/Tool hooks 保持 |
| QueryEngine ↔ ATP | `describeTools` 每轮执行，bench 覆盖 |
| QueryEngine ↔ Memory | 每轮 `runMemoryRound` 同步文件、选择记录、注入 `[memory]` 段 |
| QueryEngine ↔ Context | step-28 `runScwRound` 保持，bench 覆盖 |
| QueryEngine ↔ Skills | step-29 `runSkillRound` 保持，demo/smoke 覆盖 CLI |
| dispatch ↔ Pool | `swarm-100` bench 覆盖 100 上限 |
| /goal ↔ QueryEngine | `goal --help` 与 step-23 smoke 保持 |
| Memory ↔ Checkpoint | step-26/28 smoke 保持；总 smoke 覆盖 memory write/search |

## 验收命令

```bash
bun run typecheck
bun run smoke
bun run bench
bun run demo
bun run build
```

## 结果

```text
bun run typecheck
PASS

bun run smoke
8 passed, 0 failed

bun run bench
PASS ATP describe: 0.15ms / 5ms
PASS Memory FTS5 search: 1.55ms / 10ms
PASS Swarm spawn 100: 66.26ms / 800ms
PASS Context rebuild: 26.41ms / 50ms

bun run demo
PASS

bun run build
PASS, bin/chovy.js built successfully
```

## 说明

- `CHOVY_E2E_USE_MOCK=1` 为离线 smoke/demo 提供 deterministic provider response，不验证真实 HTTP。
- Bench 超阈值时打印 `WARN`，但本次四项均在阈值内。
- `queryEngine.ts` 保持 585 行（smoke 口径），低于 600 行硬限。
- 2026-06-19 复验发现 `bash scripts/demo.sh` 在未安装 WSL distro 的 Windows 环境不可复现；已补 `scripts/demo.ts` + `bun run demo` 跨平台入口，`demo.sh` 改为 POSIX wrapper。
