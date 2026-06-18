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
