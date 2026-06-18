import { safeFsSync } from "../fs/index.js";
import { ChovyError } from "../types/errors.js";
import { chovyFeaturesPath } from "./home.js";

/**
 * Local feature flags. Three sources, OR-merged (any one true → enabled):
 *
 *   1. `~/.chovy/features.json`            → `{ "swarm.judge": true }`
 *   2. env `CHOVY_FEATURE_<UPPER_SNAKE>=1` → `CHOVY_FEATURE_SWARM_JUDGE=1`
 *   3. CLI flags via `setCliFeatureFlags`  → e.g. `--feature swarm.judge`
 *
 * Flags are dot-separated (e.g. `swarm.judge`, `goal.streamingPlan`). The env
 * mapping is `dot → underscore`, all upper-case.
 *
 * NOTE: feature flag state is cached after first read for the lifetime of the
 * process. Use `resetFeaturesCache()` in tests to force a re-read.
 */

let cliFlags: Set<string> | undefined;
let fileFlags: Map<string, boolean> | undefined;

/** Drop both file and CLI caches — primarily for tests. */
export function resetFeaturesCache(): void {
  cliFlags = undefined;
  fileFlags = undefined;
}

/**
 * Register feature flags from CLI parsing. Called once near the entry point.
 * Pass an empty array to clear.
 */
export function setCliFeatureFlags(flags: readonly string[]): void {
  cliFlags = new Set(flags.map((s) => s.trim()).filter((s) => s.length > 0));
}

function loadFileFlags(path = chovyFeaturesPath()): Map<string, boolean> {
  if (fileFlags) return fileFlags;
  const out = new Map<string, boolean>();

  let raw: string;
  try {
    raw = safeFsSync.read(path);
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      fileFlags = out;
      return out;
    }
    throw new ChovyError(
      "CONFIG_INVALID",
      `failed to read ${path}: ${(err as Error).message}`,
      err,
      { path, ...(code ? { errno: code } : {}) },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonBom(raw));
  } catch (err) {
    throw new ChovyError(
      "CONFIG_INVALID",
      `${path} is not valid JSON — ${(err as Error).message}`,
      err,
      { path },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChovyError(
      "CONFIG_INVALID",
      `${path} must contain a JSON object.`,
      undefined,
      { path },
    );
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "boolean") out.set(k, v);
  }
  fileFlags = out;
  return out;
}

/** Convert `swarm.judge` → `CHOVY_FEATURE_SWARM_JUDGE`. */
function envName(name: string): string {
  return "CHOVY_FEATURE_" + name.replace(/[.-]/g, "_").toUpperCase();
}

function envEnabled(name: string): boolean {
  const v = process.env[envName(name)];
  if (v === undefined) return false;
  return v === "1" || v.toLowerCase() === "true";
}

/** Return true if the flag is enabled by any of the three sources. */
export function feature(name: string): boolean {
  if (cliFlags?.has(name)) return true;
  if (envEnabled(name)) return true;
  const fromFile = loadFileFlags().get(name);
  return fromFile === true;
}

/** Snapshot of every flag currently known to be enabled (debugging aid). */
export function listEnabledFeatures(): string[] {
  const enabled = new Set<string>();
  if (cliFlags) for (const f of cliFlags) enabled.add(f);
  for (const [k, v] of loadFileFlags()) if (v) enabled.add(k);
  for (const k of Object.keys(process.env)) {
    if (!k.startsWith("CHOVY_FEATURE_")) continue;
    const v = process.env[k];
    if (v !== "1" && v?.toLowerCase() !== "true") continue;
    // Best-effort reverse mapping: `CHOVY_FEATURE_SWARM_JUDGE` → `swarm.judge`.
    enabled.add(k.slice("CHOVY_FEATURE_".length).toLowerCase().replace(/_/g, "."));
  }
  return [...enabled].sort();
}

function stripJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function errnoOf(err: unknown): string | undefined {
  const meta = err instanceof ChovyError ? err.meta : undefined;
  const errno = meta?.["errno"];
  return typeof errno === "string" ? errno : undefined;
}
