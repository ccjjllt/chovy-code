import { readFileSync } from "node:fs";
import { z } from "zod";
import { chovyConfigPath } from "./home.js";

/**
 * Runtime configuration. Step-02 promotes this from a flat env-only object
 * into a four-source merge:
 *
 *   built-in defaults  <  ~/.chovy/config.json  <  process.env CHOVY_*  <  args
 *
 * Later sources win. The result is validated by zod, frozen (deep) and
 * cached so repeat calls are cheap.
 *
 * NOTE: `apiKey` lives in `secrets.ts` now — config.ts intentionally has no
 * notion of API keys.
 */

const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "minimax",
  "glm",
  "kimi",
] as const;

const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;

const SwarmSchema = z.object({
  parallelism: z.number().int().min(1).max(100).default(8),
  maxSubAgents: z.number().int().min(1).max(100).default(100),
  budgetUSD: z.number().min(0).default(5),
});

const MemorySchema = z.object({
  enabled: z.boolean().default(true),
  injectBudgetTokens: z.number().int().min(0).default(4096),
});

const ContextSchema = z.object({
  softRatio: z.number().min(0).max(1).default(0.75),
  hardRatio: z.number().min(0).max(1).default(0.9),
  reserveTokens: z.number().int().min(0).default(2048),
});

const ConfigSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default("openai"),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(1).default(4096),
  verbose: z.boolean().default(false),
  permissionMode: z.enum(PERMISSION_MODES).default("default"),
  swarm: SwarmSchema.default({}),
  memory: MemorySchema.default({}),
  context: ContextSchema.default({}),
});

export type ChovyConfig = z.infer<typeof ConfigSchema>;
/** Backwards-compatible alias for the original `Config` name. */
export type Config = ChovyConfig;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Plain-object form used during the merge — every field optional. */
export type PartialConfig = {
  provider?: ChovyConfig["provider"];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  verbose?: boolean;
  permissionMode?: PermissionMode;
  swarm?: Partial<ChovyConfig["swarm"]>;
  memory?: Partial<ChovyConfig["memory"]>;
  context?: Partial<ChovyConfig["context"]>;
};

// ---------------------------------------------------------------------------
// Layer 2: file
// ---------------------------------------------------------------------------

function readFileLayer(path = chovyConfigPath()): PartialConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Missing config file is the common case — silently fall back to defaults.
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw new Error(
      `CONFIG_INVALID: failed to read ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `CONFIG_INVALID: ${path} is not valid JSON — ${(err as Error).message}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`CONFIG_INVALID: ${path} must contain a JSON object.`);
  }
  return parsed as PartialConfig;
}

// ---------------------------------------------------------------------------
// Layer 3: env
// ---------------------------------------------------------------------------

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function bool(s: string | undefined): boolean | undefined {
  if (s === undefined) return undefined;
  if (s === "1" || s.toLowerCase() === "true") return true;
  if (s === "0" || s.toLowerCase() === "false") return false;
  return undefined;
}

function readEnvLayer(env: NodeJS.ProcessEnv): PartialConfig {
  const out: PartialConfig = {};

  if (env["CHOVY_PROVIDER"]) out.provider = env["CHOVY_PROVIDER"] as ChovyConfig["provider"];
  if (env["CHOVY_MODEL"]) out.model = env["CHOVY_MODEL"];
  const temp = num(env["CHOVY_TEMPERATURE"]);
  if (temp !== undefined) out.temperature = temp;
  const max = num(env["CHOVY_MAX_TOKENS"]);
  if (max !== undefined) out.maxTokens = max;
  const verbose = bool(env["CHOVY_VERBOSE"]);
  if (verbose !== undefined) out.verbose = verbose;
  if (env["CHOVY_PERMISSION_MODE"]) {
    out.permissionMode = env["CHOVY_PERMISSION_MODE"] as PermissionMode;
  }

  const swarm: PartialConfig["swarm"] = {};
  const par = num(env["CHOVY_SWARM_PARALLELISM"]);
  if (par !== undefined) swarm.parallelism = par;
  const maxSub = num(env["CHOVY_SWARM_MAX_SUB_AGENTS"]);
  if (maxSub !== undefined) swarm.maxSubAgents = maxSub;
  const budget = num(env["CHOVY_SWARM_BUDGET_USD"]);
  if (budget !== undefined) swarm.budgetUSD = budget;
  if (Object.keys(swarm).length > 0) out.swarm = swarm;

  const memory: PartialConfig["memory"] = {};
  const memEnabled = bool(env["CHOVY_MEMORY_ENABLED"]);
  if (memEnabled !== undefined) memory.enabled = memEnabled;
  const inject = num(env["CHOVY_MEMORY_INJECT_BUDGET"]);
  if (inject !== undefined) memory.injectBudgetTokens = inject;
  if (Object.keys(memory).length > 0) out.memory = memory;

  const context: PartialConfig["context"] = {};
  const soft = num(env["CHOVY_CONTEXT_SOFT_RATIO"]);
  if (soft !== undefined) context.softRatio = soft;
  const hard = num(env["CHOVY_CONTEXT_HARD_RATIO"]);
  if (hard !== undefined) context.hardRatio = hard;
  const reserve = num(env["CHOVY_CONTEXT_RESERVE_TOKENS"]);
  if (reserve !== undefined) context.reserveTokens = reserve;
  if (Object.keys(context).length > 0) out.context = context;

  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Shallow-merge `a < b` for top-level fields, deep-merge for nested objects. */
function mergeLayer(base: PartialConfig, over: PartialConfig): PartialConfig {
  const out: PartialConfig = { ...base };
  for (const key of Object.keys(over) as Array<keyof PartialConfig>) {
    const v = over[key];
    if (v === undefined) continue;
    if (
      (key === "swarm" || key === "memory" || key === "context") &&
      typeof v === "object" &&
      v !== null
    ) {
      const prev = (base[key] ?? {}) as Record<string, unknown>;
      (out[key] as Record<string, unknown>) = { ...prev, ...(v as Record<string, unknown>) };
    } else {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/** Cached snapshot keyed by env+args identity — cleared by `resetConfigCache`. */
let cached: ChovyConfig | undefined;
let cachedKey = "";

export interface LoadConfigOptions {
  /** Process env to read from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Explicit overrides (highest precedence — usually CLI flags). */
  args?: PartialConfig;
  /** Override the config file path (testing only). */
  filePath?: string;
}

/**
 * Read configuration from the four sources and return a frozen, validated
 * object. Throws an Error whose message starts with `CONFIG_INVALID:` on
 * malformed input — step-01 will upgrade these to ChovyError.
 */
export function loadConfig(opts: LoadConfigOptions = {}): ChovyConfig {
  const env = opts.env ?? process.env;
  const args = opts.args ?? {};

  const key = JSON.stringify({
    f: opts.filePath ?? chovyConfigPath(),
    e: extractEnvSubset(env),
    a: args,
  });
  if (cached && cachedKey === key) return cached;

  const fileLayer = readFileLayer(opts.filePath);
  const envLayer = readEnvLayer(env);

  const merged = mergeLayer(mergeLayer(fileLayer, envLayer), args);

  let parsed: ChovyConfig;
  try {
    parsed = ConfigSchema.parse(merged);
  } catch (err) {
    throw new Error(
      `CONFIG_INVALID: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cached = deepFreeze(parsed);
  cachedKey = key;
  return cached;
}

/** Drop the cached config — primarily for tests. */
export function resetConfigCache(): void {
  cached = undefined;
  cachedKey = "";
}

function extractEnvSubset(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    if (k.startsWith("CHOVY_")) out[k] = env[k];
  }
  return out;
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") {
    for (const k of Object.keys(o)) {
      deepFreeze((o as Record<string, unknown>)[k]);
    }
    Object.freeze(o);
  }
  return o;
}
