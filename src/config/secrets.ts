import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "../types/index.js";
import { chovySecretsDir } from "./home.js";

/**
 * Per-provider API key + base URL resolution.
 *
 * Lookup order for the API key:
 *   1. `process.env[<ENV_KEYS[provider]>]`
 *   2. plain-text file at `~/.chovy/secrets/<provider>` (trimmed)
 *
 * Lookup order for the base URL:
 *   1. `process.env[<PROVIDER>_BASE_URL]`
 *   2. provider's documented default (returned as `undefined` here — the
 *      provider adapter itself owns the default).
 *
 * Keychain integration is intentionally out of scope (see step-02 §2).
 */

export const ENV_KEYS: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  minimax: "MINIMAX_API_KEY",
  glm: "GLM_API_KEY",
  kimi: "KIMI_API_KEY",
};

const BASE_URL_KEYS: Record<ProviderId, string> = {
  openai: "OPENAI_BASE_URL",
  anthropic: "ANTHROPIC_BASE_URL",
  gemini: "GEMINI_BASE_URL",
  deepseek: "DEEPSEEK_BASE_URL",
  minimax: "MINIMAX_BASE_URL",
  glm: "GLM_BASE_URL",
  kimi: "KIMI_BASE_URL",
};

// Cached on first read to avoid re-stat-ing the secrets file on every call.
const cache = new Map<ProviderId, string | null>();

/** Force a fresh read on the next `getSecret` call (testing helper). */
export function resetSecretsCache(): void {
  cache.clear();
}

function readSecretFromFile(provider: ProviderId): string | undefined {
  const path = join(chovySecretsDir(), provider);
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

/** Return the API key for `provider`, or `undefined` if none configured. */
export function getSecret(provider: ProviderId): string | undefined {
  const cached = cache.get(provider);
  if (cached !== undefined) return cached ?? undefined;

  const fromEnv = process.env[ENV_KEYS[provider]];
  if (fromEnv && fromEnv.length > 0) {
    cache.set(provider, fromEnv);
    return fromEnv;
  }

  const fromFile = readSecretFromFile(provider);
  if (fromFile && fromFile.length > 0) {
    cache.set(provider, fromFile);
    return fromFile;
  }

  cache.set(provider, null);
  return undefined;
}

/** True iff the provider has an API key reachable via env or secrets file. */
export function hasSecret(provider: ProviderId): boolean {
  return getSecret(provider) !== undefined;
}

/**
 * Optional base-URL override (self-hosted gateway / Azure / regional proxy).
 * Returns `undefined` when the provider should use its built-in default.
 */
export function getBaseUrl(provider: ProviderId): string | undefined {
  const v = process.env[BASE_URL_KEYS[provider]];
  return v && v.length > 0 ? v : undefined;
}

/** The env var name where `provider` looks for its API key. */
export function envKeyFor(provider: ProviderId): string {
  return ENV_KEYS[provider];
}
