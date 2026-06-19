import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { join } from "node:path";

import {
  envKeyFor,
  hasSecret,
  resetConfigCache,
  resetSecretsCache,
  type PermissionMode,
} from "../config/index.js";
import {
  chovyConfigPath,
  chovySecretsDir,
  ensureHomeDirs,
  safeFs,
  safeFsSync,
} from "../fs/index.js";
import { listProviders, getProvider } from "../providers/index.js";
import { ChovyError } from "../types/errors.js";
import type { ProviderId } from "../types/index.js";

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
];

export interface ConfigWizardOptions {
  provider?: string;
  model?: string;
  key?: string;
  permissionMode?: string;
  nonInteractive?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface ConfigWizardResult {
  provider: ProviderId;
  model: string | undefined;
  permissionMode: PermissionMode;
  keyStatus: "configured" | "missing";
  configPath: string;
  secretPath: string;
  envKey: string;
}

type JsonObject = Record<string, unknown>;

interface CurrentConfig {
  provider?: ProviderId;
  model?: string;
  permissionMode?: PermissionMode;
  raw: JsonObject;
}

export async function runConfigWizard(
  opts: ConfigWizardOptions = {},
): Promise<ConfigWizardResult> {
  const input = opts.stdin ?? defaultStdin;
  const output = opts.stdout ?? defaultStdout;
  const interactive = opts.nonInteractive !== true;

  ensureHomeDirs();

  if (interactive && !input.isTTY) {
    throw new ChovyError(
      "CONFIG_INVALID",
      [
        "chovy config requires an interactive TTY.",
        `For non-interactive setup, run: chovy config --non-interactive --provider <id> --model <id> --key <value>`,
        `Or edit ${chovyConfigPath()} and ${join(chovySecretsDir(), "<provider>")} manually.`,
      ].join("\n"),
      undefined,
      { configPath: chovyConfigPath(), secretsDir: chovySecretsDir() },
    );
  }

  const current = readCurrentConfig();
  const providers = sortedProviderIds();
  const currentProvider = current.provider ?? "openai";

  let provider = parseProvider(opts.provider, "--provider");
  let model = opts.model;
  let permissionMode = parsePermissionMode(opts.permissionMode, "--permission-mode");
  let key = opts.key;

  if (interactive) {
    const restoreRawMode = enterCookedMode(input);
    try {
      writeLine(output, "chovy config");
      writeLine(output, "");
      writeCurrentSummary(output, currentProvider, current);
      writeLine(output, "");

      let shouldUpdateKey = key !== undefined;
      const rl = createInterface({ input, output });
      try {
        provider = await askProvider(rl, output, providers, provider ?? currentProvider);
        model = await askModel(rl, provider);
        permissionMode = await askPermissionMode(rl, output, permissionMode ?? "default");
        if (key === undefined) {
          shouldUpdateKey = await askYesNo(rl, output, keyPrompt(provider), false);
        } else {
          writeLine(output, "API key supplied by flag; it will be stored without being displayed.");
        }
      } finally {
        rl.close();
      }
      if (shouldUpdateKey && key === undefined) {
        key = await askSecret(input, output, `API key for ${provider}: `);
      }
    } finally {
      restoreRawMode();
    }
  } else {
    provider ??= currentProvider;
    permissionMode ??= current.permissionMode ?? "default";
  }

  if (!provider) {
    throw new ChovyError("CONFIG_INVALID", "provider is required.");
  }
  if (!permissionMode) {
    throw new ChovyError("CONFIG_INVALID", "permissionMode is required.");
  }

  const config = { ...current.raw };
  removeSecretLikeFields(config);
  config["provider"] = provider;
  if (model !== undefined) {
    const trimmed = model.trim();
    if (trimmed.length > 0) config["model"] = trimmed;
    else delete config["model"];
  } else if (interactive) {
    delete config["model"];
  }
  config["permissionMode"] = permissionMode;

  await safeFs.write(chovyConfigPath(), JSON.stringify(config, null, 2) + "\n");

  if (key !== undefined) {
    const trimmed = key.trim();
    if (trimmed.length > 0) {
      await safeFs.mkdirp(chovySecretsDir());
      await safeFs.write(join(chovySecretsDir(), provider), trimmed);
      resetSecretsCache();
    }
  }
  resetConfigCache();

  const result: ConfigWizardResult = {
    provider,
    model: typeof config["model"] === "string" ? config["model"] : undefined,
    permissionMode,
    keyStatus: hasSecret(provider) ? "configured" : "missing",
    configPath: chovyConfigPath(),
    secretPath: join(chovySecretsDir(), provider),
    envKey: envKeyFor(provider),
  };

  writeLine(output, "");
  writeLine(output, formatConfigSummary(result));
  return result;
}

export function formatConfigSummary(result: ConfigWizardResult): string {
  return [
    "Configuration saved.",
    `  provider=${result.provider}`,
    `  model=${result.model ?? getProvider(result.provider).info.defaultModel} (${result.model ? "configured" : "provider default"})`,
    `  permissionMode=${result.permissionMode}`,
    `  key=${result.keyStatus} (${result.envKey} or ${result.secretPath})`,
    "",
    `Next: chovy chat "hello"`,
  ].join("\n");
}

function readCurrentConfig(): CurrentConfig {
  let raw: string;
  try {
    raw = safeFsSync.read(chovyConfigPath());
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") return { raw: {} };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonBom(raw));
  } catch (err) {
    throw new ChovyError(
      "CONFIG_INVALID",
      `${chovyConfigPath()} is not valid JSON — ${(err as Error).message}`,
      err,
      { path: chovyConfigPath() },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChovyError(
      "CONFIG_INVALID",
      `${chovyConfigPath()} must contain a JSON object.`,
      undefined,
      { path: chovyConfigPath() },
    );
  }

  const rawObject = parsed as JsonObject;
  return {
    raw: rawObject,
    provider: isProviderId(rawObject["provider"]) ? rawObject["provider"] : undefined,
    model: typeof rawObject["model"] === "string" ? rawObject["model"] : undefined,
    permissionMode: isPermissionMode(rawObject["permissionMode"])
      ? rawObject["permissionMode"]
      : undefined,
  };
}

function writeCurrentSummary(
  output: NodeJS.WriteStream,
  provider: ProviderId,
  current: CurrentConfig,
): void {
  writeLine(output, `Current provider: ${provider}`);
  writeLine(output, `Current model: ${current.model ?? getProvider(provider).info.defaultModel} (${current.model ? "configured" : "provider default"})`);
  writeLine(output, `Current permissionMode: ${current.permissionMode ?? "default"}`);
  writeLine(output, `Current key: ${hasSecret(provider) ? "configured" : "missing"} (${envKeyFor(provider)} or ${join(chovySecretsDir(), provider)})`);
}

async function askProvider(
  rl: ReadlineInterface,
  output: NodeJS.WriteStream,
  providers: readonly ProviderId[],
  fallback: ProviderId,
): Promise<ProviderId> {
  writeLine(output, `Providers: ${providers.join(", ")}`);
  while (true) {
    const answer = (await rl.question(`Provider [${fallback}]: `)).trim();
    const value = answer.length > 0 ? answer : fallback;
    if (isProviderId(value)) return value;
    writeLine(output, `Unknown provider "${value}". Choose one of: ${providers.join(", ")}`);
  }
}

async function askModel(
  rl: ReadlineInterface,
  provider: ProviderId,
): Promise<string> {
  const defaultModel = getProvider(provider).info.defaultModel;
  const answer = await rl.question(`Model (Enter for provider default: ${defaultModel}): `);
  return answer.trim();
}

async function askPermissionMode(
  rl: ReadlineInterface,
  output: NodeJS.WriteStream,
  fallback: PermissionMode,
): Promise<PermissionMode> {
  while (true) {
    const answer = (await rl.question(`Permission mode [${fallback}]: `)).trim();
    const value = answer.length > 0 ? answer : fallback;
    if (isPermissionMode(value)) return value;
    writeLine(output, `Unknown permission mode "${value}". Choose one of: ${PERMISSION_MODES.join(", ")}`);
  }
}

async function askYesNo(
  rl: ReadlineInterface,
  output: NodeJS.WriteStream,
  prompt: string,
  fallback: boolean,
): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  while (true) {
    const answer = (await rl.question(`${prompt} [${suffix}]: `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    writeLine(output, "Please answer y or n.");
  }
}

function keyPrompt(provider: ProviderId): string {
  const status = hasSecret(provider) ? "configured" : "missing";
  return `Write or update API key for ${provider}? (${status}; env ${envKeyFor(provider)})`;
}

async function askSecret(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  prompt: string,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new ChovyError(
      "CONFIG_INVALID",
      "cannot safely read an API key from this terminal; use --non-interactive --key or write the secret file manually.",
    );
  }

  output.write(prompt);
  const wasRaw = Boolean((input as { isRaw?: boolean }).isRaw);
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          reject(new ChovyError("CONFIG_INVALID", "config wizard cancelled."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          output.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

function sortedProviderIds(): ProviderId[] {
  return listProviders()
    .map((p) => p.info.id)
    .sort((a, b) => a.localeCompare(b));
}

function parseProvider(value: string | undefined, flag: string): ProviderId | undefined {
  if (value === undefined) return undefined;
  if (isProviderId(value)) return value;
  throw new ChovyError(
    "CONFIG_INVALID",
    `unknown ${flag} "${value}". Expected one of: ${sortedProviderIds().join(", ")}`,
    undefined,
    { provider: value },
  );
}

function parsePermissionMode(
  value: string | undefined,
  flag: string,
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (isPermissionMode(value)) return value;
  throw new ChovyError(
    "CONFIG_INVALID",
    `unknown ${flag} "${value}". Expected one of: ${PERMISSION_MODES.join(", ")}`,
    undefined,
    { permissionMode: value },
  );
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && sortedProviderIds().includes(value as ProviderId);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

function removeSecretLikeFields(config: JsonObject): void {
  for (const key of Object.keys(config)) {
    if (/api[_-]?key/i.test(key) || /secret/i.test(key)) {
      delete config[key];
    }
  }
}

function writeLine(output: NodeJS.WriteStream, text: string): void {
  output.write(text + "\n");
}

function enterCookedMode(input: NodeJS.ReadStream): () => void {
  if (!input.isTTY || typeof input.setRawMode !== "function") return () => {};
  const wasRaw = Boolean((input as { isRaw?: boolean }).isRaw);
  if (wasRaw) input.setRawMode(false);
  return () => {
    if (wasRaw) input.setRawMode(true);
  };
}

function stripJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function errnoOf(err: unknown): string | undefined {
  const meta = err instanceof ChovyError ? err.meta : undefined;
  const errno = meta?.["errno"];
  return typeof errno === "string" ? errno : undefined;
}
