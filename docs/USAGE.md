# chovy-code 使用手册

## 安装与启动

```bash
bun install
bun run start "解释这个仓库"
bun run build
bun bin/chovy.js --version
```

如果只想跑离线验收：

```bash
CHOVY_E2E_USE_MOCK=1 OPENAI_API_KEY=mock bun run smoke
```

## 常用命令

```bash
chovy                         # 进入交互式 REPL
chovy "解释当前目录"           # 一次性 prompt
chovy chat "say hi"           # 显式一次性 prompt
chovy goal "让 typecheck 通过" --cmd "bun run typecheck"
chovy mem list
chovy mem write "we use Bun + Ink" --layer project --type decision --importance 90
chovy mem search "Bun Ink"
chovy agent list --builtins
chovy skill list
chovy provider list
chovy log tail
```

## Provider

支持的 provider：

- `openai`
- `anthropic`
- `gemini`
- `deepseek`
- `minimax`
- `glm`
- `kimi`

密钥读取顺序：

1. 环境变量，例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`。
2. `~/.chovy/secrets/<provider>` 明文文件。

可用 `CHOVY_E2E_USE_MOCK=1` 跑离线 mock provider，适合 smoke/demo/CI。

## Slash Commands

REPL 内常用：

| 命令 | 用途 |
|---|---|
| `/help` | 显示 REPL 帮助 |
| `/goal <objective>` | 启动长程目标循环 |
| `/checkpoint now` | 手动写 checkpoint |
| `/checkpoint list` | 列出 checkpoint |
| `/skill list` | 查看技能 |
| `/skill <name>` | 手动激活技能 |
| `/skill clear` | 清空手动技能 |
| `/provider` | 查看或切换 provider |
| `/mode` | 查看或切换权限模式 |
| `/quit` | 退出 |

## Persistent Memory

项目记忆位于 `~/.chovy/projects/<project-id>/`：

| 文件 | 层级 | 用途 |
|---|---|---|
| `MEMORY.md` | project | 长期项目决策、规则、偏好 |
| `notes.md` | notes | 临时工作记忆 |
| `checkpoints/latest.md` | checkpoint | 最近结构化快照 |
| `tasks/<id>/progress.md` | progress | `/goal` 任务进度 |
| `memory.db` | index | SQLite + FTS5 派生索引 |

写入示例：

```bash
chovy mem write "provider registry is the only provider entrypoint" \
  --layer project --type rule --importance 85 --tag provider
```

下一次 agent 运行时，QueryEngine 会同步这些文件并注入相关 `[memory]` 段；有条目时会显示 `memory loaded: N entries`。

## Multi-Agent Swarm

主 agent 可通过 `dispatch` 一次分发多个子 agent，最多 100 个，默认并发 8。每个子 agent 有独立 AbortController、预算、工具权限和生命周期。

CLI 查看：

```bash
chovy agent list
chovy agent list --builtins
```

## `/goal` Long-Running Tasks

`goal` 用收敛判据驱动多轮执行：

```bash
chovy goal "让项目通过 typecheck" --cmd "bun run typecheck" --max-rounds 25 --budget-usd 5
```

收敛模式：

- `--cmd`：命令退出码为 0 即达成。
- `--rubric`：用文字判据评估。
- 同时传 `--cmd` 与 `--rubric`：hybrid 模式，两者都要满足。

## Permission Modes

| 模式 | 行为 |
|---|---|
| `default` | 需要确认的操作会询问用户 |
| `plan` | 只读/规划，不允许变更 |
| `acceptEdits` | 文件编辑自动放行，危险操作仍受保护 |
| `auto` | 安全白名单自动放行，未知操作询问 |
| `bypassPermissions` | 尽量放行，但硬安全规则仍不可绕过 |

硬安全规则包括：不改 shell/git/secrets 配置，不碰 `.git/`，不使用 `--no-verify`，不 force push。

## Configuration

配置合并优先级：

```text
built-in defaults < ~/.chovy/config.json < CHOVY_* env < CLI flags
```

示例：

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "permissionMode": "default",
  "memory": {
    "enabled": true,
    "injectBudgetTokens": 4096
  },
  "context": {
    "softRatio": 0.75,
    "hardRatio": 0.9,
    "reserveTokens": 2048
  },
  "swarm": {
    "parallelism": 8,
    "maxSubAgents": 100,
    "budgetUSD": 5
  }
}
```

## Demo And Verification

```bash
bun run smoke
bun run bench
bun run demo
```

`scripts/demo.sh` 仍保留为 POSIX wrapper，内部调用 `bun run demo`；
Windows 用户直接使用 `bun run demo`。
