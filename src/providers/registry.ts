import type { Provider, ProviderId } from "../types/index.js";

/**
 * Central provider registry. Each concrete adapter registers itself here at
 * import time. To add a provider:
 *   1. Implement `Provider` in `src/providers/<name>.ts`
 *   2. Register it in `src/providers/index.ts`
 *
 * Keeping registration in one place makes the set of supported providers
 * discoverable and avoids circular imports.
 */
const registry = new Map<ProviderId, Provider>();

export function registerProvider(provider: Provider): void {
  if (registry.has(provider.info.id)) {
    throw new Error(`Provider already registered: ${provider.info.id}`);
  }
  registry.set(provider.info.id, provider);
}

export function getProvider(id: ProviderId): Provider {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export function listProviders(): Provider[] {
  return [...registry.values()];
}

/**
 * Test-only escape hatch — pop a provider out of the registry. Returns
 * the previous adapter so tests can re-install it after the test run.
 * Production code paths never call this; the leading underscore makes
 * the intent obvious in greps.
 */
export function _unregisterProviderForTesting(id: ProviderId): Provider | undefined {
  const prev = registry.get(id);
  registry.delete(id);
  return prev;
}
