/**
 * Hook settings snapshot — startup-time freeze (step-13).
 *
 * At SessionStart the engine reads `settings.json` once and stores an
 * in-memory copy. All subsequent hook executions during the session read
 * this snapshot, *not* the disk — so editing `settings.json` mid-chat
 * does NOT take effect until the next session. This closes the
 * "hot-reload injection" risk: an attacker (or a confused user) who can
 * write the project's `.chovy/settings.json` can't introduce a malicious
 * hook partway through a trusted session.
 *
 * This is cc-haha's `hooksConfigSnapshot.ts` idea, trimmed: cc-haha's
 * version reconciles multiple settings sources (user/project/local/policy)
 * + managed-only policy; chovy has one merge order (user → project) and a
 * separate `trust.ts` boundary, so the snapshot is a plain `HookConfig[]`.
 *
 * The snapshot is owned by the engine instance (one per session / sub-
 * agent — sub-agents get their own snapshot per AGENTS.md §9). Tests can
 * construct one directly and pass it to `createHookEngine`.
 */

import type { HookConfig } from "../../types/hook.js";
import {
  defaultSettingsPaths,
  loadSettingsFromPaths,
  loadSettingsFromText,
} from "./settings.js";

/**
 * Frozen hook configuration. `hooks` is the merged, timeout-defaulted
 * list captured at snapshot time; `source` records where it came from
 * (for telemetry / UI explanation).
 */
export interface HookSnapshot {
  hooks: HookConfig[];
  /** Paths the snapshot was loaded from (for "why did this hook fire?"). */
  sources: string[];
}

/**
 * Capture a snapshot from disk. Reads `paths` (default: user + project
 * settings) exactly once and freezes the result. Call this at SessionStart;
 * the engine holds the returned object for the session's lifetime.
 *
 * Missing files are silently skipped (the common case). A snapshot with
 * zero hooks is valid — most sessions have none.
 */
export function captureSnapshot(opts: {
  cwd: string;
  paths?: string[];
}): HookSnapshot {
  const paths = opts.paths ?? defaultSettingsPaths(opts.cwd);
  const hooks = loadSettingsFromPaths(paths);
  return { hooks, sources: paths };
}

/**
 * Capture a snapshot from pre-loaded text (tests / smoke scripts that
 * want to inject settings without touching disk). Each entry's `source`
 * label is the array index for traceability.
 */
export function captureSnapshotFromText(entries: { json: string; source: string }[]): HookSnapshot {
  const hooks: HookConfig[] = [];
  for (const { json, source } of entries) {
    for (const h of loadSettingsFromText(json, source)) hooks.push(h);
  }
  return { hooks, sources: entries.map((e) => e.source) };
}

/**
 * Capture a snapshot from a pre-parsed hook list (tests / managed hooks).
 * Bypasses disk entirely; the caller is responsible for validity.
 */
export function captureSnapshotFromHooks(hooks: HookConfig[]): HookSnapshot {
  return { hooks, sources: ["<inline>"] };
}

/**
 * Does the snapshot contain *any* hook for `event`? Cheap pre-check the
 * engine uses to short-circuit `emit` when nothing's configured — avoids
 * spawning the matcher loop for every tool call on a hookless session.
 */
export function hasHookForEvent(snapshot: HookSnapshot, event: string): boolean {
  return snapshot.hooks.some((h) => h.event === event);
}
