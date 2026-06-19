# chovy-code

`chovy-code` is a multi-provider coding-agent CLI built with **Bun + TypeScript + React/Ink**.
It can run one-shot prompts, open an interactive REPL, call tools, spawn sub-agents, keep project memory, rebuild long contexts, and load intent-specific skills.

## Innovations At A Glance

| Innovation | What it does | Try it |
|---|---|---|
| ATP | Chooses lean/full tool descriptions per turn under a token budget. | `bun run bench:tool-budget` |
| SwarmR | Dispatches up to 100 sub-agents and optionally aggregates with a judge. | `bun run bench:swarm-100` |
| TMT | Stores project memory/checkpoints/notes/progress in files plus SQLite FTS. | `bun run smoke` |
| SCW | Monitors context pressure and rebuilds from structured snapshots. | `bun run bench:context-rebuild` |
| CSG | Plans the smallest useful skill graph instead of dumping every skill. | `bun src/cli/index.tsx skill list` |

## TUI Phase J-P Plan

The next TUI roadmap is documented in [`docs/tui/README.md`](docs/tui/README.md). It upgrades the Ink REPL with a small original-color GIF companion, Ctrl+P command palette, purple-dominant blue-accent theme, MiMo-style zh/en i18n, and Settings.

Planning gates:

- Command/slash coverage targets at least 72 cc-haha-equivalent user-visible commands.
- Bundled skills target at least 15 CSG skills while preserving `requires` / `provides` / `conflicts`.
- Coverage reports must include `byGroup` / `bySource` / `nonCounted`; hidden, disabled, TODO, and backend-missing entries do not count.
- Full command and skill coverage matrix: [`docs/tui/command-skill-coverage.md`](docs/tui/command-skill-coverage.md).

## Quick Start

```bash
bun install
bun run typecheck
bun run smoke
bun run demo

# One-shot from source
bun run start "explain this repo"

# Build the bundled CLI
bun run build
bun bin/chovy.js --version
```

For offline integration checks, set `CHOVY_E2E_USE_MOCK=1`; provider calls return a deterministic local response.

## CLI

```bash
chovy [prompt]
chovy chat "explain this file"
chovy goal "make bun run typecheck pass" --cmd "bun run typecheck"
chovy mem write "we use Bun + Ink" --layer project --type decision --importance 90
chovy mem search "Bun Ink"
chovy agent list --builtins
chovy skill list
chovy provider list
```

Slash commands in the REPL include `/goal`, `/checkpoint`, `/skill`, `/provider`, `/mode`, `/help`, and `/quit`.

## Configuration

Config merges built-in defaults, `~/.chovy/config.json`, `CHOVY_*` environment variables, and CLI flags.
API keys are read from env first, then `~/.chovy/secrets/<provider>`.

Provider ids: `openai`, `anthropic`, `gemini`, `deepseek`, `minimax`, `glm`, `kimi`.

Permission modes: `default`, `plan`, `acceptEdits`, `auto`, `bypassPermissions`.

## Development

```bash
bun run typecheck
bun run smoke
bun run demo
bun run bench
bun run build
```

More detail:

- [Usage guide](docs/USAGE.md)
- [Developer guide](docs/DEVELOPING.md)
- [Known limitations](docs/KNOWN-LIMITATIONS.md)
- [Architecture](docs/architecture.md)
- [30-step roadmap](docs/README.md)

## License

MIT
