#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import { version } from "../version.js";
import {
  loadConfig,
  hasSecret,
  envKeyFor,
  setCliFeatureFlags,
  type PartialConfig,
  type PermissionMode,
} from "../config/index.js";
import { logger } from "../logger/index.js";
import { ensureHomeDirs, ensureProjectDirs } from "../fs/index.js";
import { listProviders, getProvider } from "../providers/index.js"; // side-effect: registers providers
import { listTools } from "../tools/index.js"; // side-effect: registers tools
import { ChovyError } from "../types/errors.js";
import { AgentRepl } from "./components/AgentRepl.js";
import { ChovyRepl } from "./repl.js";
import type { ProviderId } from "../types/index.js";

// Force import side effects even when tree-shaking is aggressive.
void listProviders;
void listTools;

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
];

interface CommonFlags {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  permissionMode?: string;
  feature?: string[];
  verbose?: boolean;
}

interface ResolvedCtx {
  provider: ProviderId;
  model: string | undefined;
  mode: PermissionMode;
}

/**
 * Apply common flags + load config + boot home dirs. Used by every
 * subcommand so behaviour is consistent regardless of how the user
 * invoked the CLI.
 */
function resolveCtx(opts: CommonFlags): ResolvedCtx {
  if (opts.verbose && !process.env["CHOVY_LOG_LEVEL"]) logger.setLevel("debug");
  if (opts.feature?.length) setCliFeatureFlags(opts.feature);

  // Build the chovy home + per-project skeleton before anything that
  // reads/writes disk runs. ensure*Dirs are idempotent and cheap; failure
  // (typically EACCES on a locked-down home dir) bubbles up as a single
  // logged error instead of a stack trace from inside a downstream module.
  try {
    ensureHomeDirs();
    ensureProjectDirs(process.cwd());
  } catch (err) {
    logError(err);
    process.exit(2);
  }

  const args: PartialConfig = {};
  if (opts.provider) args.provider = opts.provider as ProviderId;
  if (opts.model) args.model = opts.model;
  if (opts.temperature !== undefined) args.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) args.maxTokens = opts.maxTokens;
  if (opts.verbose) args.verbose = true;
  if (opts.permissionMode) {
    if (!PERMISSION_MODES.includes(opts.permissionMode as PermissionMode)) {
      logger.error(new ChovyError(
        "CONFIG_INVALID",
        `unknown --permission-mode "${opts.permissionMode}". Expected one of: ${PERMISSION_MODES.join(", ")}`,
        undefined,
        { permissionMode: opts.permissionMode },
      ));
      process.exit(2);
    }
    args.permissionMode = opts.permissionMode as PermissionMode;
  }

  let config;
  try {
    config = loadConfig({ args });
  } catch (err) {
    logError(err);
    process.exit(2);
  }

  return {
    provider: config.provider,
    model: config.model,
    mode: config.permissionMode,
  };
}

function assertProviderReady(provider: ProviderId): void {
  if (hasSecret(provider)) return;
  const label = safeProviderLabel(provider);
  logger.error(new ChovyError(
    "PROVIDER_NOT_READY",
    `${label} API key missing. Set ${envKeyFor(provider)} in your environment, or write the key to ~/.chovy/secrets/${provider}.`,
    undefined,
    { provider, envKey: envKeyFor(provider) },
  ));
  process.exit(2);
}

function startRepl(ctx: ResolvedCtx): void {
  if (!process.stdin.isTTY) {
    logger.error(new ChovyError(
      "CONFIG_INVALID",
      'interactive REPL requires a TTY; run `chovy chat "..."` for non-interactive use.',
    ));
    process.exit(2);
  }

  // Do not gate REPL boot on PROVIDER_NOT_READY — the user may want to use
  // /provider, /mode, /help, etc. without keys; the first real prompt will
  // surface the missing-key error from the agent loop.
  const model = ctx.model ?? getProvider(ctx.provider).info.defaultModel;
  // CHOVY_DISABLE_RAW=1 hands Ctrl+C back to Ink (Windows ConHost
  // workaround). Otherwise we own the key so the REPL can implement
  // "interrupt running agent without exiting" per step-05.
  const exitOnCtrlC = process.env["CHOVY_DISABLE_RAW"] === "1";
  render(
    <ChovyRepl provider={ctx.provider} model={model} initialMode={ctx.mode} />,
    { exitOnCtrlC },
  );
}

function startOneShot(prompt: string, ctx: ResolvedCtx): void {
  assertProviderReady(ctx.provider);
  logger.debug(
    `provider=${ctx.provider} model=${ctx.model ?? "(default)"} ` +
      `permissionMode=${ctx.mode}`,
  );
  render(
    <AgentRepl prompt={prompt} provider={ctx.provider} model={ctx.model} permissionMode={ctx.mode} />,
    { exitOnCtrlC: true },
  );
}

function commandFromActionArgs(args: readonly unknown[]): Command {
  const last = args[args.length - 1];
  if (last instanceof Command) return last;
  throw new ChovyError("INTERNAL", "Commander action did not provide command context.");
}

function resolveCtxFromActionArgs(args: readonly unknown[]): ResolvedCtx {
  return resolveCtx(commandFromActionArgs(args).optsWithGlobals() as CommonFlags);
}

const program = new Command();

program
  .name("chovy")
  .description("A coding agent built with Bun + TypeScript + React/Ink.")
  .version(version)
  .option("-p, --provider <id>", "provider: openai|anthropic|gemini|deepseek|minimax|glm|kimi")
  .option("-m, --model <id>", "override the provider's default model")
  .option("-t, --temperature <n>", "sampling temperature", parseFloatOpt)
  .option("--max-tokens <n>", "max tokens for the completion", parseIntOpt)
  .option(
    "--permission-mode <mode>",
    `permission mode: ${PERMISSION_MODES.join("|")}`,
  )
  .option(
    "--feature <name>",
    "enable a local feature flag (repeatable, e.g. --feature swarm.judge)",
    collect,
    [] as string[],
  )
  .option("-v, --verbose", "enable debug logging (== CHOVY_LOG_LEVEL=debug)")
  // Default behaviour: no prompt → REPL, prompt → one-shot. Equivalent to
  // `chovy chat [prompt]` but without forcing the subcommand keystrokes.
  .argument("[prompt]", "one-shot prompt; omit to enter the interactive REPL")
  .action((prompt: string | undefined, opts: CommonFlags) => {
    const ctx = resolveCtx(opts);
    if (!prompt) { startRepl(ctx); return; }
    startOneShot(prompt, ctx);
  });

// `chovy chat [prompt]` — explicit form of the default behaviour.
program
  .command("chat [prompt]")
  .description("一次性对话；省略 prompt 进入交互式 REPL")
  .action((prompt: string | undefined, ...args: unknown[]) => {
    const ctx = resolveCtxFromActionArgs(args);
    if (!prompt) { startRepl(ctx); return; }
    startOneShot(prompt, ctx);
  });

// `chovy goal "..."` — placeholder until step-23 lands the loop.
program
  .command("goal <objective>")
  .description("启动 /goal 长程任务（占位，TODO step-23）")
  .action((objective: string, ...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info(`/goal: ${objective}`);
    logger.info("（goal 循环将于 step-23 接入；当前仅记录目标。）");
  });

// `chovy mem ...` — TODO step-25.
const mem = program.command("mem").description("记忆操作（TODO step-24/25）");
mem.command("list").description("列出记忆条目")
  .action((...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info("memory list — TODO step-25");
  });
mem.command("show <key>").description("展示某个记忆条目")
  .action((key: string, ...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info(`memory show ${key} — TODO step-25`);
  });
mem.command("search <query>").description("全文搜索记忆")
  .action((query: string, ...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info(`memory search "${query}" — TODO step-25`);
  });

// `chovy agent ...` — TODO step-22.
const agent = program.command("agent").description("子 agent 操作（TODO step-22）");
agent.command("list").description("列出活跃子 agent")
  .action((...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info("agent list — TODO step-22");
  });

// `chovy skill ...` — TODO step-29.
const skill = program.command("skill").description("技能操作（TODO step-29）");
skill.command("list").description("列出已加载技能")
  .action((...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info("skill list — TODO step-29");
  });

// `chovy log tail` — point at the local telemetry sink (step-03).
const log = program.command("log").description("本地 telemetry 操作");
log.command("tail").description("提示 telemetry 文件位置")
  .action((...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    logger.info("log tail — 见 ~/.chovy/telemetry/<date>.jsonl");
  });

// `chovy provider list` — discoverability.
const providerCmd = program.command("provider").description("provider 列表");
providerCmd.command("list").description("列出已注册 provider")
  .action((...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    for (const p of listProviders()) {
      logger.info(`${p.info.id}\t${p.info.label}\tdefault=${p.info.defaultModel}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logError(err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseFloatOpt(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`expected a number, got "${value}"`);
  }
  return n;
}

function parseIntOpt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`expected an integer, got "${value}"`);
  }
  return n;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function safeProviderLabel(id: ProviderId): string {
  try {
    return getProvider(id).info.label;
  } catch {
    return id;
  }
}

function logError(err: unknown): void {
  logger.error(err instanceof Error ? err : new Error(String(err)));
}
