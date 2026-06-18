/**
 * Smoke tests for step-04 (FS abstraction).
 *
 * Run with: `bun run scripts/smoke-step-04.ts`
 *
 * Validates:
 *   1. ensureHomeDirs creates the expected skeleton under CHOVY_HOME=<tmp>.
 *   2. ensureProjectDirs builds the per-project subtree.
 *   3. safeFs.write is atomic (no .tmp leftovers) and < 30 ms for 50 KB.
 *   4. safeFs.remove refuses paths outside chovy home.
 *   5. CHOVY_HOME override is respected.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { readdir } from "node:fs/promises";

const tmp = mkdtempSync(join(tmpdir(), "chovy-step04-"));
process.env.CHOVY_HOME = tmp;

const {
  chovyHome,
  chovySecretsDir,
  chovyProjectsDir,
  chovyTelemetryDir,
  ensureHomeDirs,
} = await import("../src/fs/home.js");
const {
  ensureProjectDirs,
  projectDir,
  projectId,
  checkpointDir,
  tasksDir,
  sessionsDir,
  memoryFile,
} = await import("../src/fs/paths.js");
const { safeFs } = await import("../src/fs/safeFs.js");
const { isChovyError } = await import("../src/types/errors.js");

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`[step-04] CHOVY_HOME=${tmp}`);

// 1) ensureHomeDirs
ensureHomeDirs();
check("chovyHome respects CHOVY_HOME", chovyHome() === tmp, chovyHome());
check("home dir exists", existsSync(chovyHome()));
check("secrets/ exists", existsSync(chovySecretsDir()));
check("projects/ exists", existsSync(chovyProjectsDir()));
check("telemetry/ exists", existsSync(chovyTelemetryDir()));

// 2) ensureProjectDirs
const fakeCwd = process.cwd();
ensureProjectDirs(fakeCwd);
const id = projectId(fakeCwd);
check("projectId is 12 hex chars", /^[0-9a-f]{12}$/.test(id), id);
check("projectDir exists", existsSync(projectDir(fakeCwd)));
check("checkpoints/ exists", existsSync(checkpointDir(fakeCwd)));
check("tasks/ exists", existsSync(tasksDir(fakeCwd)));
check("sessions/ exists", existsSync(sessionsDir(fakeCwd)));

// 3) atomic write speed for 50 KB
const target = memoryFile(fakeCwd);
const payload = "x".repeat(50 * 1024);
const t0 = performance.now();
await safeFs.write(target, payload);
const dt = performance.now() - t0;
check(`write 50KB < 30ms (took ${dt.toFixed(2)}ms)`, dt < 30, `${dt.toFixed(2)}ms`);
check("written file exists", existsSync(target));
check("written file size matches", statSync(target).size === payload.length);

// no .tmp leftovers in the project dir
const dir = dirname(target);
const entries = await readdir(dir);
const stragglers = entries.filter((n) => n.endsWith(".tmp"));
check("no .tmp stragglers after atomic write", stragglers.length === 0, stragglers.join(","));

// roundtrip
const round = await safeFs.read(target);
check("read returns the written content", round === payload);

// stat
const st = await safeFs.stat(target);
check("stat returns size + mtime", st !== null && st.size === payload.length);

// list
const files = await safeFs.list(dir);
check("list returns at least 1 file", files.length >= 1);

// 4) remove guardrail — outside chovy home
let denied = false;
try {
  await safeFs.remove(tmpdir());
} catch (err) {
  denied = isChovyError(err) && err.code === "MEMORY_IO";
}
check("remove() refuses paths outside chovy home", denied);

// remove root chovy home itself
let rootDenied = false;
try {
  await safeFs.remove(chovyHome());
} catch (err) {
  rootDenied = isChovyError(err) && err.code === "MEMORY_IO";
}
check("remove() refuses chovy home root", rootDenied);

// remove inside project dir is allowed
await safeFs.write(join(projectDir(fakeCwd), "scratch.txt"), "hello");
await safeFs.remove(join(projectDir(fakeCwd), "scratch.txt"));
check(
  "remove() inside project dir succeeds",
  !existsSync(join(projectDir(fakeCwd), "scratch.txt")),
);

// cleanup
rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n[step-04] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`\n[step-04] all checks passed (basename=${basename(tmp)})`);
