# Step 30 — Integration & E2E（端到端连通 + Demo + Bench）

**Phase**: I | **依赖**: 23,28,29 | **可并行**: ❌（合流） | **估时**: 6h

## 目标

把所有模块拉通为**生产可用**的 chovy-code：
1. 各模块的接线全部就位；
2. 提供端到端 demo 脚本；
3. 提供 smoke test 与 bench；
4. 更新 README 与帮助文本；
5. 一份"已知限制"清单。

## 产物

```
docs/
├── USAGE.md              # 终端用户使用手册
├── DEVELOPING.md         # 开发者贡献指南
└── KNOWN-LIMITATIONS.md
scripts/
├── demo.sh               # 演示 5 个创新点
├── smoke.ts              # 启动级 smoke test
└── bench/
    ├── tool-budget.bench.ts
    ├── memory-fts.bench.ts
    ├── swarm-100.bench.ts
    └── context-rebuild.bench.ts
src/cli/
└── index.tsx             # 最终菜单更新
```

## 接线检查表

| 项 | 检查 |
|---|---|
| QueryEngine ↔ Permission | 每个 tool 调用必经 6 层；本地测试 + telemetry 验证 |
| QueryEngine ↔ Hooks | Pre/PostToolUse 钩子被调用 |
| QueryEngine ↔ ATP | 每轮 system prompt 中工具描述按预算选择 |
| QueryEngine ↔ Memory | 每轮注入 [memory] 段 |
| QueryEngine ↔ Context | soft/hard 触发与重建 |
| QueryEngine ↔ Skills | activeSkillFragments 注入 |
| dispatch ↔ Pool | 100 上限 |
| dispatch ↔ Judge | 默认 consensus |
| /goal ↔ QueryEngine | Stop-hook 注入；rounds 累加 |
| /goal ↔ Checkpoint | 每 N 轮触发 |
| Memory ↔ Checkpoint | latest.md upsert 入 db |

## End-to-End Demo（demo.sh）

```bash
#!/usr/bin/env bash
set -e

# 1. ATP：工具预算演示
chovy --provider glm "请只用 Glob 找出当前目录所有 .ts 文件" \
  | grep "level=lean.*level=full"

# 2. Swarm + Judge：异构子 agent + 聚合
chovy --provider openai "对比 Bun 与 Node 在启动速度、生态、TS 原生支持三方面，dispatch 三个 agent 用不同 provider"

# 3. Goal Loop：让仓库 typecheck 通过
chovy /goal "bun run typecheck 通过"

# 4. Memory：第二次进入会话注入
chovy /mem write --layer project --type decision --importance 80 "we use Bun + Ink"
chovy "新需求：xxx"   # 检查 [memory] 段出现

# 5. Context Rebuild：构造长会话
node scripts/seed-long-session.ts        # 把会话填到 70%
chovy "继续刚才的任务"                    # 应触发 soft 提示
node scripts/seed-long-session.ts --hard # 填到 92%
chovy "继续"                              # 应触发 hard 重建
```

## Smoke test

```ts
// scripts/smoke.ts
const cases = [
  { cmd: ['chovy','--version'], expect: /\d+\.\d+\.\d+/ },
  { cmd: ['chovy','--provider','openai','say hi'], expect: /\S/ },
  { cmd: ['chovy','mem','list'], expect: /MEMORY/ },
  { cmd: ['chovy','provider','list'], expect: /openai.*anthropic.*glm/ },
];
for (const c of cases) {
  // spawn + match；失败即非 0 退出
}
```

CI 中用 `bun run smoke`。

## Bench

| Bench | 阈值（参考） |
|---|---|
| ATP describe（25 tool, budget 2k） | ≤ 5ms |
| Memory FTS5 search（5k records） | ≤ 10ms |
| Swarm spawn 100（mocked LLM） | ≤ 800ms |
| Context rebuild（200k → 30k） | ≤ 50ms |

不达标即 CI 警告（不阻断）。

## README 更新

新增章节：

- **Innovations at a glance** —— 5 个核心创新介绍 + 一行 demo；
- **Slash commands** —— 完整斜杠命令表；
- **Persistent memory** —— MEMORY.md 怎么写；
- **Multi-agent swarm** —— `dispatch` 用法；
- **/goal long-running tasks** —— rubric 写法；
- **Permission modes** —— 5 种模式何时用；
- **Configuration** —— `~/.chovy/config.json` 完整 schema；
- **Architecture** —— 链接到 docs/architecture.md。

## Known limitations

```md
- Anthropic prompt cache 仅在 anthropic provider 上启用；其他 provider 仅诊断。
- WebFetch 不执行 JS（无 headless browser）。
- Bash sandbox 在 Windows 弱化（无 bwrap）。
- Vision 输入仅 OpenAI/Anthropic/Gemini/GLM 支持。
- 多文件原子提交未实现（每文件独立写）。
- 不支持团队记忆共享（TEAMMEM 留作 future）。
```

## 验收标准

- demo.sh 全部通过；
- smoke.ts 全部通过；
- bench 数字在阈值内；
- `chovy --help` 与 `chovy <cmd> --help` 文本完整且最新；
- 第一次启动新项目 → 引导用户启用 MEMORY；
- 第二次启动 → 自动注入 + 简短 banner "memory loaded: 12 entries"。

## 参考源

- 全部 30 步的 docs。

## 风险

- 集成期暴露的接口冲突 → 在每个屏障点复盘；30 步 docs 中预留接口冻结清单（见 architecture.md §3.3）。
- 端到端测试依赖真实 API → 提供 `CHOVY_E2E_USE_MOCK=1` 走本地 mock provider；CI 默认 mock。
