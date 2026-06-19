# chovy-code 开发者指南

## 本地循环

```bash
bun install
bun run typecheck
bun run smoke
bun run bench
bun run build
```

`bun run smoke` 默认走 `CHOVY_E2E_USE_MOCK=1`，不需要真实 API key。真实 provider 冒烟请显式设置 provider key 后单独运行。

## 工作原则

- 先读 `docs/README.md`、`docs/architecture.md`、`docs/innovations.md` 和对应 step 文档。
- 接口冻结后只追加可选字段，不重命名、不替换旧字段。
- 不修改 `bin/chovy.js` 和 `.map`，它们是构建产物。
- 不引入 GrowthBook、Docker/VM sandbox、TEAMMEM、Anthropic-only prompt-cache 价格优化。
- 不复刻 cc-haha 全量代码；只借鉴设计，并保留 chovy 的 ATP/SwarmR/TMT/SCW/CSG 主线。

## 目录导览

| 路径 | 说明 |
|---|---|
| `src/engine/` | QueryEngine 主循环、工具执行、SCW/CSG/TMT glue |
| `src/tools/` | Tool Protocol v2、ATP 描述选择、核心工具 |
| `src/harness/` | 权限、hook、sandbox |
| `src/providers/` | 7 provider adapter、PCM、SSE、tool format |
| `src/agent/` | 子 agent pool、内置角色、snapshot |
| `src/swarm/` | dispatch、并发、预算、judge |
| `src/memory/` | TMT store、文件同步、checkpoint writer、injection |
| `src/context/` | SCW monitor、budget、rebuilder、selectors |
| `src/skills/` | CSG registry、graph、planner、bundled skills |
| `src/cli/` | Commander 命令、Ink REPL、slash commands |
| `scripts/` | smoke、bench、demo、step 验收脚本 |

## 新增 Provider

1. 在 `src/providers/capabilities.ts` 增加 PCM 能力。
2. 实现 `Provider` 接口；OpenAI-compatible 优先走 `createOpenAICompatProvider`。
3. 在 `src/providers/index.ts` 注册。
4. 跑 `bun run typecheck` 和 provider 冒烟。

## 新增 Tool

1. 实现 `Tool`，包含 `desc.lean`、`desc.full`、`family`、`fullTriggers`。
2. 实现 `checkPermissions`。
3. 在 `src/tools/index.ts` 注册。
4. 跑 ATP 相关 smoke/bench，确认 lean/full 选择稳定。

## 新增 Skill

1. 在 `src/skills/bundled/` 新增技能文件。
2. 字段必须符合 `src/types/skill.ts`：`name`、`summary`、`triggers`、`systemFragment`、`budgetTokens`。
3. 如有依赖/冲突，填写 `requires`、`provides`、`conflicts`。
4. 在 `src/skills/bundled/index.ts` 注册。
5. 跑 `bun run scripts/smoke-step29.ts`。

## Smoke And Bench

总 smoke：

```bash
bun run smoke
```

Bench：

```bash
bun run bench:tool-budget
bun run bench:memory-fts
bun run bench:swarm-100
bun run bench:context-rebuild
```

Bench 超阈值只打印 `WARN`，不阻断 CI；类型错误和 smoke 失败应阻断。

跨平台 demo：

```bash
bun run demo
```

`scripts/demo.sh` 只是 POSIX wrapper；Windows 复验不要依赖 WSL/bash。

## Mock E2E

`CHOVY_E2E_USE_MOCK=1` 会让 OpenAI-compatible provider 返回本地 deterministic completion：

```bash
CHOVY_E2E_USE_MOCK=1 OPENAI_API_KEY=mock bun run start "say hi"
```

用途：

- CI 不依赖真实 API。
- 验证 CLI/QueryEngine/ATP/Memory/Telemetry 接线。
- demo 脚本保持可复现。

## PR Checklist

- `bun run typecheck`
- `bun run smoke`
- `bun run demo`
- 相关 step smoke
- 必要时 `bun run bench`
- README/docs 与 CLI help 一致
- 没有修改构建产物和 secrets
