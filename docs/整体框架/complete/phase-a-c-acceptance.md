# Phase A-C 复验报告

> 复验日期：2026-06-18  
> 范围：Phase A（step-01–05）、Phase B（step-06–11）、Phase C（step-12–14）  
> 结论：Phase A-C 当前代码通过复验；本轮发现并修复 1 个 Windows 沙箱环境变量问题。可进入 Phase D（step-15 system prompt / step-16 QueryEngine / step-17 providers）。

---

## 1. 复验依据

- `docs/README.md`
- `docs/architecture.md`
- `docs/innovations.md`
- `docs/protocols/tool-v2.md`
- `docs/step-01-types-and-error-model.md` 到 `docs/step-14-sandbox.md`
- `docs/complete/` 下 step-01 到 step-14 完成报告，以及 Phase A / Phase B 汇总报告
- `AGENTS.md`
- `源码解析.md`
- `D:/Desktop/cc-haha-main/` 中与本阶段相关的权限、Hook、Bash、沙箱、工具系统参考点

参考 cc-haha 时只吸收分层、快照、权限硬边界、hint 单槽、沙箱路径校验等工程模式；未复刻 GrowthBook、TEAMMEM、Docker/VM 沙箱、Buddy、语音模式或完整 cc-haha 代码。

---

## 2. 本轮发现并修复的问题

| ID | 问题 | 影响 | 修复 |
|---|---|---|---|
| C1 | Windows `process.env` 常见键名为 `Path`，但 `filterEnv()` 只精确保留 `PATH` | `buildSandboxSpawnArgs()` 生成降级沙箱环境时会丢失可执行文件搜索路径，`smoke-step14` 失败 `env keeps PATH` | `shellSandbox.ts` 在 Windows 下对白名单环境变量做大小写无关匹配，并将 `Path` 规范输出为 `PATH`；`CHOVY_*` 在 Windows 下同样大小写无关保留 |

相关不变量已补入 `AGENTS.md §16`，追补记录已补入 `docs/complete/step-14-sandbox.md`。

---

## 3. 实测命令

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | PASS |
| `bun run scripts/smoke-step-04.ts` | PASS，20 项通过 |
| `bun run scripts/smoke-step07.ts` | PASS，6 个 ATP case；`tools.described` 事件数符合预期 |
| `bun run scripts/smoke-fs-tools.ts` | PASS，16 项通过 |
| `bun run scripts/smoke-step09.ts` | PASS，25 项通过 |
| `bun run scripts/smoke-step10.ts` | PASS，14 项通过 |
| `bun run scripts/smoke-step11.ts` | PASS，45 项通过 |
| `bun run scripts/smoke-step12.ts` | PASS，20 项通过 |
| `bun run scripts/smoke-step13.ts` | PASS，38 项通过 |
| `bun run scripts/smoke-step14.ts` | 初次 45/46；修复 C1 后 PASS，46/46 |
| `bun run scripts/smoke-phase-b-acceptance.ts` | PASS，11 项通过 |

本轮未运行真实网络 provider E2E；非 OpenAI provider 真实接线仍属 step-17，WebFetch 在线 example.com 测试需 `SMOKE_NETWORK=1` 显式开启。

---

## 4. 接口与不变量确认

- `Tool` / `ToolContext` / `ToolResult` 冻结面未破坏；agent loop 仍负责构造 `ToolContext` 并传给 `tool.run(args, ctx)`。
- `tool.call` telemetry 仍由 agent loop wrapper 单源发射；工具内部不直接发射。
- `HookEvent` / `PermissionMode` / `AgentRole` 仍保持单源字面量联合，其他层通过 type re-export 复用。
- L1g safety 对 `bypassPermissions` 免疫；沙箱 `assertWritable` 作为物理守卫补齐 symlink / cwd 归属。
- Hook 引擎启动快照、Trust 边界、PermissionRequest decisive 语义保持不变。
- Windows 沙箱降级路径现在保留规范 `PATH`，不会因为 `Path` 大小写丢失命令搜索路径。

---

## 5. 当前边界

已完成：
- Phase A：类型/错误模型、配置/secrets/features、logger/telemetry、safeFs/chovy home、CLI/REPL 骨架。
- Phase B：Tool Protocol v2、ATP 分配器、fs/exec/web/meta 9 个核心工具。
- Phase C：权限引擎、Hook 引擎、文件系统/命令沙箱。

未实现，按原路线进入后续 Phase：
- Phase D：system prompt 分层、QueryEngine、真实 provider 接线。
- Phase E-I：子智能体、SwarmR、Goal loop、TMT 记忆、SCW 上下文管理、CSG 技能图、端到端集成。

工作树注意：复验前已有未跟踪 `nul` 文件，本轮未删除、未修改该文件。
