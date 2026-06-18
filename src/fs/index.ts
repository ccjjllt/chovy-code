/**
 * Public barrel for the FS module.
 *
 * Higher-level modules should import from `chovy-code/fs` rather than
 * cherry-picking individual files; this keeps the import surface small
 * and lets us re-organize internals later without churning callers.
 */

export {
  chovyHome,
  chovyConfigPath,
  chovyFeaturesPath,
  chovySecretsDir,
  chovyProjectsDir,
  chovyTelemetryDir,
  ensureHomeDirs,
  _resetHomeEnsureCacheForTesting,
} from "./home.js";

export {
  projectId,
  projectDir,
  memoryFile,
  notesFile,
  memoryDb,
  checkpointDir,
  latestCheckpointFile,
  tasksDir,
  taskDir,
  sessionsDir,
  sessionFile,
  skillsLockFile,
  ensureProjectDirs,
  _resetProjectEnsureCacheForTesting,
} from "./paths.js";

export { safeFs, safeFsSync, isWithin } from "./safeFs.js";
export type { SafeFs, SafeFsSync } from "./safeFs.js";
