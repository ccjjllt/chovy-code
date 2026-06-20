/**
 * Cross-platform Step-30 demo runner.
 *
 * This intentionally avoids shell pipes so Windows users can run the same
 * offline demo with `bun run demo`; scripts/demo.sh remains a POSIX wrapper.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface DemoStep {
  name: string;
  command: string[];
  expect: RegExp[];
  env?: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src", "cli", "index.tsx");
const home = mkdtempSync(join(tmpdir(), "chovy-demo-"));

const baseEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  CHOVY_HOME: home,
  CHOVY_E2E_USE_MOCK: "1",
  OPENAI_API_KEY: "mock",
  CHOVY_LOG_LEVEL: "info",
};

const steps: DemoStep[] = [
  {
    name: "ATP: adaptive lean/full tool descriptions",
    command: ["bun", "run", "bench:tool-budget"],
    expect: [/(PASS|WARN) ATP describe/],
  },
  {
    name: "SwarmR: dispatch 100 mocked sub-agents",
    command: ["bun", "run", "bench:swarm-100"],
    expect: [/(PASS|WARN) Swarm spawn 100/],
  },
  {
    name: "TMT + mock E2E: isolated memory write/search + provider chat",
    command: ["bun", "run", "smoke"],
    expect: [/PASS\s+mem write/, /PASS\s+mem search/, /PASS\s+mock provider chat/, /\d+ passed, 0 failed/],
  },
  {
    name: "SCW: context rebuild benchmark",
    command: ["bun", "run", "bench:context-rebuild"],
    expect: [/(PASS|WARN) Context rebuild/],
  },
  {
    name: "CSG: skill graph is available and inspectable",
    command: ["bun", cli, "skill", "list"],
    env: { CHOVY_SKILLS_AUTO: "1" },
    expect: [/commit[\s\S]*review[\s\S]*ts-fix/],
  },
  {
    name: "Bonus: /goal headless entry",
    command: ["bun", cli, "goal", "--help"],
    expect: [/--max-rounds[\s\S]*--budget-usd/],
  },
  {
    name: "TUI Innovations: Theme, Locale, Mascot cache, Settings, Coverage",
    command: ["bun", "run", "smoke:tui"],
    expect: [/All smoke tests passed/],
  }
];

try {
  console.log("== chovy-code demo: five innovations ==\n");
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const out = await run(step.command, { ...baseEnv, ...(step.env ?? {}) });
    const ok = out.code === 0 && step.expect.every((pattern) => pattern.test(out.combined));
    if (!ok) {
      console.log(`FAIL ${i + 1}) ${step.name}`);
      console.log(`     command: ${step.command.join(" ")}`);
      console.log(`     exit: ${out.code}`);
      console.log(`     output: ${compact(out.combined)}`);
      process.exitCode = 1;
      break;
    }

    console.log(`PASS ${i + 1}) ${step.name}`);
    const line = firstUsefulLine(out.combined);
    if (line) console.log(`     ${line}`);
  }

  if (!process.exitCode) console.log("\nDemo complete.");
} finally {
  tryRemove(home);
}

async function run(
  command: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; combined: string }> {
  const proc = Bun.spawn(command, {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, combined: `${stdout}\n${stderr}` };
}

function firstUsefulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(PASS|WARN|===|commit\b|review\b|ts-fix\b|Usage:)/.test(line));
}

function compact(text: string): string {
  return text.slice(0, 1000).replace(/\s+/g, " ").trim();
}

function tryRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup; demo assertions have already completed.
  }
}
