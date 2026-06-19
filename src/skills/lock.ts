/**
 * skills.lock persistence (step-29 — CSG).
 *
 * Cached signature of the last resolved skill graph. Lets `runSkillRound`
 * skip replanning when intent hasn't changed (fingerprint match).
 *
 * Format (`docs/step-29-skill-graph.md` §"持久化"):
 *
 *   {
 *     "lastSelected": ["format","commit"],
 *     "ts": 1718700000000,
 *     "fingerprint": "abc123def456",
 *     "version": 1
 *   }
 *
 * Mirrors `src/goals/goalState.ts:persistGoal/loadGoal` exactly:
 *   - `safeFs.write` (atomic) for write
 *   - `safeFs.exists` + `safeFs.read` + JSON.parse for load
 *   - errors logged + swallowed (returns null), in-memory state authoritative
 *
 * AGENTS.md §20 single-source: `safeFs` is the only fs touchpoint here.
 */

import { logger } from "../logger/index.js";
import { safeFs } from "../fs/safeFs.js";
import { skillsLockFile } from "../fs/paths.js";

/** Persisted shape. `version` lets future migrations branch cleanly. */
export interface SkillsLock {
  lastSelected: string[];
  ts: number;
  fingerprint: string;
  /** Schema version. Increment when fields are removed or renamed. Today
   *  always `1`; older lockfiles without this field are coerced to `1`. */
  version?: number;
}

/** Atomic write to `~/.chovy/projects/<id>/skills.lock`. */
export async function persistSkillsLock(
  cwd: string,
  lock: SkillsLock,
): Promise<void> {
  const path = skillsLockFile(cwd);
  const json = JSON.stringify(
    { ...lock, version: lock.version ?? 1 },
    null,
    2,
  );
  try {
    await safeFs.write(path, json);
  } catch (err) {
    logger.warn("persistSkillsLock failed (state stays in memory)", {
      cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load the lockfile. Returns null on missing/corrupt files (errors logged
 * + swallowed). Coerces missing `version` to `1`.
 */
export async function loadSkillsLock(cwd: string): Promise<SkillsLock | null> {
  const path = skillsLockFile(cwd);
  if (!(await safeFs.exists(path))) return null;
  try {
    const raw = await safeFs.read(path);
    const parsed = JSON.parse(raw) as Partial<SkillsLock>;
    if (
      !parsed ||
      typeof parsed.fingerprint !== "string" ||
      !Array.isArray(parsed.lastSelected) ||
      typeof parsed.ts !== "number"
    ) {
      logger.warn("loadSkillsLock: malformed lock file; ignoring", { path });
      return null;
    }
    return {
      lastSelected: parsed.lastSelected.filter(
        (s): s is string => typeof s === "string",
      ),
      ts: parsed.ts,
      fingerprint: parsed.fingerprint,
      version: parsed.version ?? 1,
    };
  } catch (err) {
    logger.warn("loadSkillsLock failed; ignoring", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
