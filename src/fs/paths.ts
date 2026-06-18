/**
 * Project-scoped paths under `~/.chovy/projects/<id>/`.
 *
 * The "project id" is `sha1(normalizedCwd).slice(0, 12)` — short enough to
 * keep filesystem listings tidy, wide enough that collisions across a
 * single user's machine are vanishingly rare.
 *
 * Normalization rules (so `D:\foo` and `d:/foo` map to the same id on
 * Windows, while POSIX paths are kept verbatim):
 *   - `path.resolve(cwd)` to make it absolute and collapse `.` / `..`
 *   - on Windows: lowercase the drive letter, convert `\` → `/`
 *   - on POSIX:   leave the case alone (POSIX FS is case-sensitive)
 *
 * `ensureProjectDirs(cwd)` is idempotent per project id; call it from the
 * CLI entry point (and from tests that need the project layout pre-built).
 */

import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { join, resolve, sep } from "node:path";
import { chovyProjectsDir } from "./home.js";

function normalizeCwd(cwd: string): string {
  let resolved = resolve(cwd);
  if (platform() === "win32") {
    // `D:\Foo` and `d:/foo` should hash to the same id.
    resolved = resolved.replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase() + ":");
    resolved = resolved.split(sep).join("/");
  }
  return resolved;
}

/** 12-char hex id derived from the normalized absolute cwd. */
export function projectId(cwd: string): string {
  return createHash("sha1").update(normalizeCwd(cwd)).digest("hex").slice(0, 12);
}

/** Absolute path to the project's directory under `~/.chovy/projects/`. */
export function projectDir(cwd: string): string {
  return join(chovyProjectsDir(), projectId(cwd));
}

/** Project-scoped MEMORY.md (human + AI editable). */
export function memoryFile(cwd: string): string {
  return join(projectDir(cwd), "MEMORY.md");
}

/** Scratch / "AI-only" notes file. */
export function notesFile(cwd: string): string {
  return join(projectDir(cwd), "notes.md");
}

/** sqlite database for the FTS5-backed memory index (step-24). */
export function memoryDb(cwd: string): string {
  return join(projectDir(cwd), "memory.db");
}

/** Directory of structured checkpoint snapshots (step-26). */
export function checkpointDir(cwd: string): string {
  return join(projectDir(cwd), "checkpoints");
}

/** Convenience pointer to the most recent checkpoint. */
export function latestCheckpointFile(cwd: string): string {
  return join(checkpointDir(cwd), "latest.md");
}

/** Root for `/goal` / long-running task workspaces. */
export function tasksDir(cwd: string): string {
  return join(projectDir(cwd), "tasks");
}

/** A single task directory under `tasks/<id>/`. */
export function taskDir(cwd: string, taskId: string): string {
  return join(tasksDir(cwd), taskId);
}

/** Directory of persisted `/goal` states (step-23). One JSON per goal. */
export function goalsDir(cwd: string): string {
  return join(projectDir(cwd), "goals");
}

/** Path of a single goal's persisted state under `goals/<goal-id>.json`. */
export function goalFile(cwd: string, goalId: string): string {
  return join(goalsDir(cwd), `${goalId}.json`);
}

/** Per-goal progress log under `tasks/<goal-id>/progress.md` (step-23/26). */
export function goalProgressFile(cwd: string, goalId: string): string {
  return join(taskDir(cwd, goalId), "progress.md");
}

/** Per-session JSONL transcripts. */
export function sessionsDir(cwd: string): string {
  return join(projectDir(cwd), "sessions");
}

/** Path of a single session JSONL file. */
export function sessionFile(cwd: string, sessionId: string): string {
  return join(sessionsDir(cwd), `${sessionId}.jsonl`);
}

/** Cached signature of the resolved skill graph (step-29). */
export function skillsLockFile(cwd: string): string {
  return join(projectDir(cwd), "skills.lock");
}

// ---------------------------------------------------------------------------
// ensureProjectDirs — idempotent per id
// ---------------------------------------------------------------------------

const ensuredProjectIds = new Set<string>();

/**
 * Create the per-project directory skeleton if missing. Cached by id, so
 * repeat calls during a CLI run cost a single Set lookup.
 *
 * NOTE: callers MUST call `ensureHomeDirs()` first (or rely on the CLI
 * entry point doing so) — this function does NOT create `~/.chovy` itself.
 * Using `mkdirSync(..., { recursive: true })` makes that ordering forgiving.
 */
export function ensureProjectDirs(cwd: string): void {
  const id = projectId(cwd);
  if (ensuredProjectIds.has(id)) return;

  mkdirSync(projectDir(cwd), { recursive: true });
  mkdirSync(checkpointDir(cwd), { recursive: true });
  mkdirSync(tasksDir(cwd), { recursive: true });
  mkdirSync(sessionsDir(cwd), { recursive: true });
  mkdirSync(goalsDir(cwd), { recursive: true });

  ensuredProjectIds.add(id);
}

/** Test-only helper: forget every "already ensured" project id. */
export function _resetProjectEnsureCacheForTesting(): void {
  ensuredProjectIds.clear();
}
