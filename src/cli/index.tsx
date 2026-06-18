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
import { getSubAgentPool } from "../agent/index.js"; // step-22: pool singleton for `agent list`
import { listBuiltinAgents } from "../agent/builtin/index.js"; // step-19: built-in role registry
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

// `chovy goal "..."` — step-23 headless long-running task entry.
//   chovy goal "<objective>" [--rubric "..."] [--cmd "..."] [--max-rounds N] [--budget-usd X]
program
  .command("goal <objective>")
  .description("启动 /goal 长程任务（step-23）")
  .option("--rubric <rule>", "自定义收敛 rubric（小模型评估）")
  .option("--cmd <command>", "自定义收敛命令（exit=0 视为达成）")
  .option("--max-rounds <n>", "最大循环轮数（默认 25）", parseIntOpt)
  .option("--budget-usd <x>", "总成本上限（USD，默认 5）", parseFloatOpt)
  .action(async (
    objective: string,
    options: {
      rubric?: string;
      cmd?: string;
      maxRounds?: number;
      budgetUsd?: number;
    },
    ...rest: unknown[]
  ) => {
    const ctx = resolveCtxFromActionArgs(rest);
    assertProviderReady(ctx.provider);
    const { runHeadlessGoal } = await import("./goalHeadless.js");
    const code = await runHeadlessGoal({
      provider: ctx.provider,
      model: ctx.model ?? getProvider(ctx.provider).info.defaultModel,
      mode: ctx.mode,
      objective,
      rubric: options.rubric,
      cmd: options.cmd,
      maxRounds: options.maxRounds,
      budgetUSD: options.budgetUsd,
    });
    process.exit(code);
  });

// `chovy mem ...` — step-24 memory store CLI surface.
//   list   : top records by layer/type/importance
//   show   : pretty-print one record by id
//   search : FTS5 + BM25 (mixed ranker by default)
//   rebuild: wipe + re-parse all source files (recovery from corrupt .db)
//   stats  : record count + DB size + degraded flag
const mem = program.command("mem").description("记忆操作（step-24 store；step-25 注入）");
mem
  .command("list")
  .description("列出记忆条目")
  .option("--layer <l>", "filter by layer: project|checkpoint|notes|progress")
  .option("--type <t>", "filter by type: decision|rule|fact|pref|snapshot|progress|note|reference")
  .option("--limit <n>", "limit (default 20)", parseIntOpt)
  .action(async (
    options: { layer?: string; type?: string; limit?: number },
    ...args: unknown[]
  ) => {
    resolveCtxFromActionArgs(args);
    const { createMemoryStore, syncProject } = await import("../memory/index.js");
    const store = await createMemoryStore({ cwd: process.cwd() });
    await syncProject(process.cwd(), store);
    const filter: { layer?: import("../types/index.js").MemoryLayer; type?: import("../types/index.js").MemoryType; limit?: number; projectId: string } = {
      projectId: store.projectId,
    };
    if (options.layer) filter.layer = options.layer as import("../types/index.js").MemoryLayer;
    if (options.type) filter.type = options.type as import("../types/index.js").MemoryType;
    filter.limit = options.limit ?? 20;
    const rows = await store.list(filter);
    if (rows.length === 0) {
      logger.info("（无匹配记忆）");
      store.close();
      return;
    }
    for (const r of rows) {
      const tags = r.tags.length > 0 ? ` [${r.tags.join(",")}]` : "";
      const head = r.content.replace(/\s+/g, " ").slice(0, 120);
      logger.info(
        `${r.id}  ${r.layer.padEnd(10)} ${r.type.padEnd(10)} imp=${String(r.importance).padStart(3)}  ${head}${tags}`,
      );
    }
    store.close();
  });

mem
  .command("show <id>")
  .description("展示某个记忆条目")
  .action(async (id: string, ...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    const { createMemoryStore } = await import("../memory/index.js");
    const store = await createMemoryStore({ cwd: process.cwd() });
    const rows = await store.list({ projectId: store.projectId, limit: 10_000 });
    const found = rows.find((r) => r.id === id);
    if (!found) {
      logger.warn(`memory show: id "${id}" not found`);
      store.close();
      process.exit(1);
    }
    logger.info(`id        ${found.id}`);
    logger.info(`layer     ${found.layer}`);
    logger.info(`type      ${found.type}`);
    logger.info(`importance ${found.importance}`);
    logger.info(`source    ${found.sourcePath}${found.sourceLine ? `:${found.sourceLine}` : ""}`);
    logger.info(`tags      ${found.tags.join(", ")}`);
    logger.info(`updated   ${new Date(found.updatedAt).toISOString()}`);
    logger.info("---");
    logger.info(found.content);
    store.close();
  });

mem
  .command("search <query>")
  .description("全文搜索记忆（FTS5 BM25 + recency mix）")
  .option("--bm25", "use pure BM25 ranking (default: mixed)")
  .option("--limit <n>", "limit (default 10)", parseIntOpt)
  .option("--layer <l>", "filter by layer")
  .action(async (
    query: string,
    options: { bm25?: boolean; limit?: number; layer?: string },
    ...args: unknown[]
  ) => {
    resolveCtxFromActionArgs(args);
    const { createMemoryStore, syncProject } = await import("../memory/index.js");
    const store = await createMemoryStore({ cwd: process.cwd() });
    await syncProject(process.cwd(), store);
    const memQuery: import("../types/index.js").MemoryQuery = {
      text: query,
      ranker: options.bm25 ? "bm25" : "mixed",
      limit: options.limit ?? 10,
    };
    if (options.layer) {
      memQuery.layers = [options.layer as import("../types/index.js").MemoryLayer];
    }
    const rows = await store.search(memQuery);
    if (rows.length === 0) {
      logger.info("（无匹配）");
      store.close();
      return;
    }
    for (const r of rows) {
      const head = r.content.replace(/\s+/g, " ").slice(0, 140);
      const score = r.score !== undefined ? `score=${r.score.toFixed(3)} ` : "";
      logger.info(`${score}${r.id}  ${r.layer}/${r.type} imp=${r.importance}  ${head}`);
    }
    store.close();
  });

mem
  .command("rebuild")
  .description("清表重建索引（恢复损坏的 memory.db）")
  .action(async (...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    const { createMemoryStore, forceRebuild } = await import("../memory/index.js");
    const store = await createMemoryStore({ cwd: process.cwd() });
    const r = await forceRebuild(process.cwd(), store);
    logger.info(
      `mem rebuild: ${r.count} records in ${r.durMs}ms${r.degraded ? " (degraded — bun:sqlite missing)" : ""}`,
    );
    store.close();
  });

mem
  .command("stats")
  .description("展示当前 store 概况（条目数 + 路径 + degraded 标志）")
  .action(async (...args: unknown[]) => {
    resolveCtxFromActionArgs(args);
    const { createMemoryStore } = await import("../memory/index.js");
    const store = await createMemoryStore({ cwd: process.cwd() });
    const c = await store.count({ projectId: store.projectId });
    logger.info(`records   ${c}`);
    logger.info(`path      ${store.path}`);
    logger.info(`projectId ${store.projectId}`);
    logger.info(`degraded  ${store.degraded ? "true (bun:sqlite missing)" : "false"}`);
    store.close();
  });

// `chovy agent ...` — step-22: list live sub-agent handles from the pool.
//   `agent list`            → live pool snapshot
//   `agent list --builtins` → registered built-in role definitions (step-19)
const agent = program.command("agent").description("子 agent 操作（step-19/22）");
agent.command("list")
  .description("列出活跃子 agent；--builtins 列内置角色")
  .option("--builtins", "列出 step-19 注册的内置角色定义")
  .action((options: { builtins?: boolean }, ...rest: unknown[]) => {
    resolveCtxFromActionArgs(rest);
    if (options.builtins) {
      const defs = listBuiltinAgents();
      if (defs.length === 0) {
        logger.info("（暂无内置角色注册）");
        return;
      }
      for (const d of defs) {
        const tools = d.allowedTools
          ? `allow=[${d.allowedTools.join(",")}]`
          : d.disallowedTools
            ? `deny=[${d.disallowedTools.join(",")}]`
            : "tools=*";
        const mem = d.omitMemory ? "omitMemory" : "memory";
        logger.info(`${d.role.padEnd(18)}  ${tools}  ${mem}`);
      }
      return;
    }
    // Force the agent barrel to load so the pool singleton + telemetry are
    // wired even though the CLI doesn't run a QueryEngine here.
    void getSubAgentPool;
    const xs = getSubAgentPool().list();
    if (xs.length === 0) {
      logger.info("（暂无活跃子 agent）");
      return;
    }
    for (const h of xs) {
      const cost = `$${(h.costUSD ?? 0).toFixed(4)}`;
      logger.info(
        `${h.id}  ${h.role.padEnd(8)}  ${h.status.padEnd(9)}  ${h.phase}  ${cost}`,
      );
    }
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
