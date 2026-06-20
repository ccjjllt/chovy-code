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
import { setLocale } from "../i18n/index.js";
import { ensureHomeDirs, ensureProjectDirs } from "../fs/index.js";
import { listProviders, getProvider } from "../providers/index.js"; // side-effect: registers providers
import { listTools } from "../tools/index.js"; // side-effect: registers tools
import { getSubAgentPool } from "../agent/index.js"; // step-22: pool singleton for `agent list`
import { listBuiltinAgents } from "../agent/builtin/index.js"; // step-19: built-in role registry
import { ChovyError } from "../types/errors.js";
import { AgentRepl } from "./components/AgentRepl.js";
import { runConfigWizard } from "./configWizard.js";
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

interface ConfigCommandFlags {
  provider?: string;
  model?: string;
  key?: string;
  permissionMode?: string;
  theme?: string;
  lang?: string;
  nonInteractive?: boolean;
}

/**
 * Apply common flags + load config + boot home dirs. Used by every
 * subcommand so behaviour is consistent regardless of how the user
 * invoked the CLI.
 */
async function resolveCtx(opts: CommonFlags): Promise<ResolvedCtx> {
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
  await setLocale(config.i18n?.locale as any);

  return {
    provider: config.provider,
    model: config.model,
    mode: config.permissionMode,
  };
}

function assertProviderReady(provider: ProviderId): void {
  if (process.env["CHOVY_E2E_USE_MOCK"] === "1") return;
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
  if (!process.stdin.isTTY && !process.env["CHOVY_FORCE_TTY"]) {
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

async function resolveCtxFromActionArgs(args: readonly unknown[]): Promise<ResolvedCtx> {
  return await resolveCtx(commandFromActionArgs(args).optsWithGlobals() as CommonFlags);
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
  .action(async (prompt: string | undefined, opts: CommonFlags) => {
    const ctx = await resolveCtx(opts);
    if (!prompt) { startRepl(ctx); return; }
    startOneShot(prompt, ctx);
  });

// `chovy chat [prompt]` — explicit form of the default behaviour.
program
  .command("chat [prompt]")
  .description("一次性对话；省略 prompt 进入交互式 REPL")
  .action(async (prompt: string | undefined, ...args: unknown[]) => {
    const ctx = await resolveCtxFromActionArgs(args);
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
    const ctx = await resolveCtxFromActionArgs(rest);
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
  .command("write <content...>")
  .description("写入项目记忆或临时 notes，并立即更新 FTS 索引")
  .option("--layer <l>", "target layer: project|notes (default notes)", "notes")
  .option("--type <t>", "memory type: decision|rule|fact|pref|note|reference", "note")
  .option("--importance <n>", "importance 0..100 (default 50)", parseIntOpt, 50)
  .option("--tag <tag>", "add a tag (repeatable)", collect, [] as string[])
  .action(async (
    contentParts: string[],
    options: { layer: string; type: string; importance: number; tag: string[] },
    ...args: unknown[]
  ) => {
    resolveCtxFromActionArgs(args);
    const content = contentParts.join(" ").trim();
    const memory = await import("../memory/index.js");
    const layer = options.layer as import("../types/index.js").MemoryLayer;
    const type = options.type as import("../types/index.js").MemoryType;
    if (!["project", "notes"].includes(layer)) {
      logger.error(`mem write: --layer must be project or notes, got "${options.layer}"`);
      process.exitCode = 1;
      return;
    }
    if (!memory.MEMORY_TYPES.includes(type)) {
      logger.error(`mem write: unknown --type "${options.type}"`);
      process.exitCode = 1;
      return;
    }
    if (content.length === 0) {
      logger.error("mem write: content is required");
      process.exitCode = 1;
      return;
    }
    const importance = Math.max(0, Math.min(100, Math.round(options.importance)));
    if (layer === "project") {
      await memory.appendMemoryEntry(process.cwd(), {
        section: sectionForMemoryType(type),
        type,
        importance,
        content: formatTaggedContent(content, options.tag),
      });
    } else {
      const existing = await memory.readNotesFile(process.cwd());
      const body = appendTypedBullet(existing.content, "Notes", {
        type,
        importance,
        content: formatTaggedContent(content, options.tag),
      });
      await memory.writeNotesFile(process.cwd(), body);
    }
    const store = await memory.createMemoryStore({ cwd: process.cwd() });
    const synced = await memory.syncProject(process.cwd(), store);
    logger.info(`memory written: ${layer}/${type} imp=${importance} (${synced.records} indexed)`);
    store.close();
  });
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
    await resolveCtxFromActionArgs(args);
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
    await resolveCtxFromActionArgs(args);
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
    await resolveCtxFromActionArgs(args);
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
    await resolveCtxFromActionArgs(args);
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
  .action(async (options: { builtins?: boolean }, ...rest: unknown[]) => {
    await resolveCtxFromActionArgs(rest);
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

// `chovy skill ...` (step-29 — CSG).
const skill = program.command("skill").description("技能操作（CSG — step-29）");
skill.command("list").description("列出已注册技能")
  .action(async (...args: unknown[]) => {
    await resolveCtxFromActionArgs(args);
    const { ensureBundledSkillsInitialized, listSkills: listAll } =
      await import("../skills/index.js");
    await ensureBundledSkillsInitialized();
    const all = listAll();
    if (all.length === 0) {
      logger.info("（暂无技能）");
      return;
    }
    for (const s of all) {
      const reqs = (s.requires?.length ?? 0) > 0 ? ` requires=${(s.requires ?? []).join(",")}` : "";
      const provs = (s.provides?.length ?? 0) > 0 ? ` provides=${(s.provides ?? []).join(",")}` : "";
      const conf = (s.conflicts?.length ?? 0) > 0 ? ` conflicts=${(s.conflicts ?? []).join(",")}` : "";
      logger.info(`${s.name.padEnd(10)} tokens=${s.budgetTokens}${reqs}${provs}${conf}`);
      logger.info(`           ${s.summary}`);
    }
  });
skill.command("show <name>").description("打印技能 systemFragment 全文")
  .action(async (name: string, ...args: unknown[]) => {
    await resolveCtxFromActionArgs(args);
    const { ensureBundledSkillsInitialized, getSkill } =
      await import("../skills/index.js");
    await ensureBundledSkillsInitialized();
    const s = getSkill(name);
    if (!s) {
      logger.error(`unknown skill: ${name}`);
      process.exitCode = 1;
      return;
    }
    logger.info(`# ${s.name}\n${s.summary}\n\n${s.systemFragment}`);
  });

// `chovy log tail` — point at the local telemetry sink (step-03).
const log = program.command("log").description("本地 telemetry 操作");
log.command("tail").description("提示 telemetry 文件位置")
  .action(async (...args: unknown[]) => {
    await resolveCtxFromActionArgs(args);
    logger.info("log tail — 见 ~/.chovy/telemetry/<date>.jsonl");
  });

// `chovy provider list` — discoverability.
const providerCmd = program.command("provider").description("provider 列表");
providerCmd.command("list").description("列出已注册 provider")
  .action(async (...args: unknown[]) => {
    await resolveCtxFromActionArgs(args);
    for (const p of listProviders()) {
      logger.info(`${p.info.id}\t${p.info.label}\tdefault=${p.info.defaultModel}`);
    }
  });

// `chovy config` — interactive provider/model/permission/key setup.
program
  .command("config")
  .description("交互式配置：空格选择 provider，然后输入 API key")
  .option("--provider <id>", "provider: openai|anthropic|gemini|deepseek|minimax|glm|kimi")
  .option("--model <id>", "model id; omit or pass an empty value to use provider default")
  .option("--permission-mode <mode>", `permission mode: ${PERMISSION_MODES.join("|")}`)
  .option("--key <value>", "API key to write into ~/.chovy/secrets/<provider>")
  .option("--theme <name>", "set theme")
  .option("--lang <locale>", "set locale")
  .option("--non-interactive", "do not prompt; only use supplied flags and existing config")
  .action(async (options: ConfigCommandFlags, ...args: unknown[]) => {
    const command = commandFromActionArgs(args);
    const all = command.optsWithGlobals() as CommonFlags & ConfigCommandFlags;
    await resolveCtx(all);
    await runConfigWizard({
      provider: all.provider ?? options.provider,
      model: all.model ?? options.model,
      key: all.key ?? options.key,
      permissionMode: all.permissionMode ?? options.permissionMode,
      theme: all.theme ?? options.theme,
      lang: all.lang ?? options.lang,
      nonInteractive: all.nonInteractive ?? options.nonInteractive,
    });
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

function sectionForMemoryType(type: string): string {
  switch (type) {
    case "decision": return "Project Decisions";
    case "rule": return "Rules";
    case "pref": return "Preferences";
    case "reference": return "References";
    default: return "Facts";
  }
}

function formatTaggedContent(content: string, tags: readonly string[]): string {
  if (tags.length === 0) return content;
  return `${content} #${tags.map((t) => t.replace(/\s+/g, "-")).join(" #")}`;
}

function appendTypedBullet(
  raw: string,
  section: string,
  entry: { type: string; importance: number; content: string },
): string {
  const header = `## ${section}`;
  const bullet = `- ${entry.type}(${entry.importance}): ${entry.content}`;
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const existing = lines.findIndex((line) => line.trim() === header);
  if (existing < 0) {
    const prefix = raw.trim().length > 0 ? raw.trimEnd() + "\n\n" : "";
    return `${prefix}${header}\n\n${bullet}\n`;
  }
  let insertAt = lines.length;
  for (let i = existing + 1; i < lines.length; i++) {
    if (/^##+\s/.test(lines[i] ?? "")) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
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
