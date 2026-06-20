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
  theme?: string;
  lang?: string;
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

import { runFieldOnce } from "../screens/settings.js";

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
    try {
      writeLine(output, "chovy config");
      writeLine(output, "");
      writeCurrentSummary(output, currentProvider, current);
      writeLine(output, "");

      if (provider === undefined) {
        provider = await chooseProvider(input, output, providers, currentProvider);
      } else {
        writeLine(output, `Provider: ${provider}`);
      }
      model ??= current.model;
      permissionMode ??= current.permissionMode ?? "default";
      writeLine(output, `Model: ${model ?? getProvider(provider).info.defaultModel} (${model ? "configured" : "provider default"})`);
      writeLine(output, `Permission mode: ${permissionMode}`);
      writeLine(output, "");

      if (key === undefined) {
        const alreadyHasKey = hasSecret(provider);
        while (true) {
          key = await askSecret(
            input,
            output,
            alreadyHasKey
              ? `API key for ${provider} (Enter to keep existing): `
              : `API key for ${provider}: `,
          );
          if (alreadyHasKey || key.trim().length > 0) break;
          writeLine(output, "API key is required for first-time setup.");
        }
      } else {
        writeLine(output, "API key supplied by flag; it will be stored without being displayed.");
      }
    } catch (err) {
      throw err;
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

  // Use the SettingsField infrastructure to write the config.
  await runFieldOnce("provider.current", provider);
  
  if (model !== undefined) {
    await runFieldOnce("model.current", model.trim());
  } else if (interactive) {
    // Interactive mode resets model to default if not explicitly provided
    await runFieldOnce("model.current", "");
  }
  
  // Note: We use general.permissionMode to match SettingsField, 
  // though older code saved directly to config.permissionMode.
  await runFieldOnce("general.permissionMode", permissionMode);

  if (key !== undefined) {
    const trimmed = key.trim();
    if (trimmed.length > 0) {
      // SettingsField reads `loadConfig().provider` which might yield a different provider
      // if `CHOVY_PROVIDER` is set in the environment or if it lacks CLI `args` context.
      const originalEnvProvider = process.env["CHOVY_PROVIDER"];
      process.env["CHOVY_PROVIDER"] = provider;
      try {
        await runFieldOnce("provider.apiKey", trimmed);
      } finally {
        if (originalEnvProvider === undefined) {
          delete process.env["CHOVY_PROVIDER"];
        } else {
          process.env["CHOVY_PROVIDER"] = originalEnvProvider;
        }
      }
    }
  }

  // Refresh caches to match pre-refactor behavior and construct result
  if (opts.theme) await runFieldOnce("theme.name", opts.theme);
  if (opts.lang) await runFieldOnce("i18n.locale", opts.lang);
  resetConfigCache();
  resetSecretsCache();
  const finalModel = model?.trim() || undefined;

  const result: ConfigWizardResult = {
    provider,
    model: finalModel,
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

async function chooseProvider(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  providers: readonly ProviderId[],
  fallback: ProviderId,
): Promise<ProviderId> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new ChovyError(
      "CONFIG_INVALID",
      "cannot read provider selection from this terminal; use --non-interactive --provider.",
    );
  }

  let index = Math.max(0, providers.indexOf(fallback));
  const wasRaw = Boolean((input as { isRaw?: boolean }).isRaw);
  input.setRawMode(true);
  input.resume();

  const render = (): void => {
    output.write("\x1b[2J\x1b[H");
    writeLine(output, "chovy config");
    writeLine(output, "");
    writeLine(output, "Select provider");
    writeLine(output, "  Use ↑/↓ to move, Space to select, Enter to accept.");
    writeLine(output, "");
    providers.forEach((p, i) => {
      const cursor = i === index ? ">" : " ";
      const checked = i === index ? "[x]" : "[ ]";
      const info = getProvider(p).info;
      const key = hasSecret(p) ? "configured" : "missing";
      writeLine(output, `${cursor} ${checked} ${p.padEnd(10)} default=${info.defaultModel} key=${key}`);
    });
  };

  return await new Promise<ProviderId>((resolve, reject) => {
    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
    };
    const finish = (): void => {
      const selected = providers[index] ?? fallback;
      cleanup();
      writeLine(output, `Selected provider: ${selected}`);
      resolve(selected);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        reject(new ChovyError("CONFIG_INVALID", "config wizard cancelled."));
        return;
      }
      if (text === "\u001b[A" || text === "k") {
        index = (index - 1 + providers.length) % providers.length;
        render();
        return;
      }
      if (text === "\u001b[B" || text === "j") {
        index = (index + 1) % providers.length;
        render();
        return;
      }
      if (text === " " || text === "\r" || text === "\n") {
        finish();
      }
    };
    input.on("data", onData);
    render();
  });
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

function writeLine(output: NodeJS.WriteStream, text: string): void {
  output.write(text + "\n");
}

function stripJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function errnoOf(err: unknown): string | undefined {
  const meta = err instanceof ChovyError ? err.meta : undefined;
  const errno = meta?.["errno"];
  return typeof errno === "string" ? errno : undefined;
}
