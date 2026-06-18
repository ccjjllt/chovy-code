# chovy-code

A coding agent built with **Bun + TypeScript + React/Ink**.

`chovy` is an interactive coding agent CLI: you give it a prompt, it streams an
answer, and it can call tools (read files, run commands, edit code, …) in a
loop until the task is done. The architecture is provider-agnostic — the same
agent loop works against OpenAI, Anthropic, Gemini, DeepSeek, MiniMax, GLM and
Kimi by swapping one flag.

## Status

Scaffold stage. The wiring is complete and verified:

- ✅ Bun + TypeScript + Ink toolchain (typecheck, dev, build all pass)
- ✅ Commander CLI with `--provider`, `--model`, `--verbose`
- ✅ Provider registry + `Provider` interface, with OpenAI as the reference
      adapter and six scaffolded placeholders (Anthropic, Gemini, DeepSeek,
      MiniMax, GLM, Kimi)
- ✅ Tool registry + `Tool` interface, with an `echo` reference tool
- ✅ Agent loop (completion → tool calls → results → repeat) with streaming
- ✅ Ink UI (`StatusLine`, `AgentRepl`) rendering live status + streamed tokens
- ⬜ Real wire implementations for each provider (currently stubs)
- ⬜ Real tools (read/write/exec/grep/…) — only `echo` ships today

## Quick start

```bash
bun install
cp .env.example .env       # then fill in the API key for your provider

# Run from source (with file watching):
bun run dev

# One-shot prompt from source:
bun run start "explain this repo"

# Build a single self-contained binary into bin/:
bun run build
bun bin/chovy.js --version   # → 0.1.0
```

## Usage

```bash
chovy [prompt] [options]

Arguments:
  prompt                 one-shot prompt to run

Options:
  -p, --provider <id>    openai | anthropic | gemini | deepseek | minimax | glm | kimi
  -m, --model <id>       override the provider's default model
  -v, --verbose          enable debug logging
  -V, --version          output the version number
  -h, --help             display help for this command
```

Configuration is read from environment variables (see `.env.example`):

| Variable           | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `CHOVY_PROVIDER`   | Default provider id                      |
| `CHOVY_MODEL`      | Override the provider's default model    |
| `CHOVY_TEMPERATURE`| Sampling temperature (default `0.2`)     |
| `CHOVY_MAX_TOKENS` | Max completion tokens (default `4096`)   |
| `CHOVY_VERBOSE`    | `1`/`true` for debug logging             |
| `<PROVIDER>_API_KEY` | API key for the chosen provider        |

## Project layout

```
chovy-code/
├── bin/                     # build output (gitignored)
│   └── chovy.js             # bundled, self-contained CLI
├── scripts/
│   └── build.ts             # bun.build bundler + react-devtools stub
├── src/
│   ├── agent/               # the agent loop (completion → tool → repeat)
│   ├── cli/
│   │   ├── index.tsx        # commander entrypoint
│   │   └── components/      # Ink UI (AgentRepl, StatusLine)
│   ├── config/              # typed env config (zod)
│   ├── logger/              # leveled console logger
│   ├── providers/           # Provider registry + adapters
│   │   ├── openai.ts        # reference adapter
│   │   ├── scaffold.ts      # factory for not-yet-wired adapters
│   │   └── index.ts         # registers all providers
│   ├── tools/               # Tool registry + built-in tools
│   │   ├── echo.ts          # reference tool
│   │   └── index.ts         # registers all tools
│   ├── types/               # provider-agnostic type contracts
│   ├── index.ts             # public barrel
│   └── version.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Extending

### Add a real provider adapter

1. Implement the `Provider` interface in `src/providers/<name>.ts` — model it
   on `openai.ts`.
2. In `src/providers/index.ts`, replace the `scaffoldProvider({...})` call for
   that id with your real adapter's registration.

### Add a tool

1. Implement the `Tool` interface in `src/tools/<name>.ts` (declare a zod
   schema and an async `run`).
2. Register it in `src/tools/index.ts`.

That's it — the agent loop and provider layer pick tools up automatically.

## Scripts

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `bun run dev`       | Run the CLI with file-watching                 |
| `bun run start`     | Run the CLI once from source                   |
| `bun run build`     | Bundle to `bin/chovy.js`                       |
| `bun run typecheck` | `tsc --noEmit` over the project                |

## License

MIT
