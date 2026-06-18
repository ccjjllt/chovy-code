/**
 * Canonical resolver for `~/.chovy/` and its top-level subdirectories.
 *
 * Step-04 promotes home-dir handling out of `src/config/home.ts` (which
 * existed only to bootstrap config/secrets/features before the FS module
 * landed) into this module. `src/config/home.ts` re-exports from here for
 * back-compat, so existing config/secrets/features call sites are unchanged.
 *
 * Resolution order:
 *   1. `CHOVY_HOME` env var (absolute path)             — highest priority
 *   2. Windows: `%APPDATA%\chovy`
 *   3. Other:    `~/.chovy`
 *
 * `ensureHomeDirs()` is idempotent and safe to call from many entry points
 * (CLI, tests, embedded API). It only creates the directories listed in
 * `architecture.md §5` — config.json / features.json are *files* and stay
 * the responsibility of the modules that own them.
 */

import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Absolute path to the chovy home directory (does NOT create it). */
export function chovyHome(): string {
  const override = process.env["CHOVY_HOME"];
  if (override && override.length > 0) return override;

  if (platform() === "win32") {
    const appData = process.env["APPDATA"];
    if (appData && appData.length > 0) return join(appData, "chovy");
  }
  return join(homedir(), ".chovy");
}

/** Path to the global config JSON file (read by `src/config/config.ts`). */
export function chovyConfigPath(): string {
  return join(chovyHome(), "config.json");
}

/** Path to the local feature flag JSON file (read by `src/config/features.ts`). */
export function chovyFeaturesPath(): string {
  return join(chovyHome(), "features.json");
}

/** Directory holding per-provider plain-text secret files. */
export function chovySecretsDir(): string {
  return join(chovyHome(), "secrets");
}

/** Root directory under which every project gets its own `<hash(cwd)>` subdir. */
export function chovyProjectsDir(): string {
  return join(chovyHome(), "projects");
}

/** Local-only telemetry NDJSON sink directory. */
export function chovyTelemetryDir(): string {
  return join(chovyHome(), "telemetry");
}

// ---------------------------------------------------------------------------
// ensureHomeDirs — idempotent
// ---------------------------------------------------------------------------

let homeEnsuredFor: string | undefined;

/**
 * Ensure the static skeleton of `~/.chovy/` exists. Only directories are
 * created here — config.json / features.json are managed by their owners.
 *
 * Cached per resolved home path so repeat calls are basically free.
 * `CHOVY_HOME` changes between calls invalidate the cache automatically.
 */
export function ensureHomeDirs(): void {
  const home = chovyHome();
  if (homeEnsuredFor === home) return;

  // Sync mkdir is fine here: we run this once at startup before any I/O,
  // and `recursive: true` makes it a no-op when the dirs already exist.
  mkdirSync(home, { recursive: true });
  mkdirSync(chovySecretsDir(), { recursive: true });
  mkdirSync(chovyProjectsDir(), { recursive: true });
  mkdirSync(chovyTelemetryDir(), { recursive: true });

  homeEnsuredFor = home;
}

/** Test-only helper: forget that we already ran ensureHomeDirs(). */
export function _resetHomeEnsureCacheForTesting(): void {
  homeEnsuredFor = undefined;
}
