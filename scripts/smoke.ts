/**
 * Step-30 integration smoke.
 *
 * Offline by default: `CHOVY_E2E_USE_MOCK=1` makes provider calls return a
 * deterministic local response. Each run uses a temp CHOVY_HOME so memory,
 * telemetry, and config state do not leak into the user's real home.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface Case {
  name: string;
  args: string[];
  expect: RegExp;
  env?: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src", "cli", "index.tsx");
const home = mkdtempSync(join(tmpdir(), "chovy-smoke-"));

let pass = 0;
let fail = 0;

const baseEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  CHOVY_HOME: home,
  CHOVY_E2E_USE_MOCK: "1",
  OPENAI_API_KEY: "mock",
  CHOVY_LOG_LEVEL: "info",
};

const cases: Case[] = [
  { name: "version", args: ["--version"], expect: /\d+\.\d+\.\d+/ },
  { name: "top-level help", args: ["--help"], expect: /Commands:[\s\S]*goal[\s\S]*mem[\s\S]*skill/ },
  { name: "goal help", args: ["goal", "--help"], expect: /--max-rounds[\s\S]*--budget-usd/ },
  { name: "provider list", args: ["provider", "list"], expect: /anthropic[\s\S]*glm[\s\S]*openai/ },
  { name: "skill list", args: ["skill", "list"], expect: /commit[\s\S]*review[\s\S]*ts-fix/ },
  {
    name: "mem write",
    args: ["mem", "write", "we use Bun + Ink", "--layer", "project", "--type", "decision", "--importance", "90"],
    expect: /memory written: project\/decision/,
  },
  { name: "mem search", args: ["mem", "search", "Bun Ink"], expect: /Bun \+ Ink/ },
  { name: "mock provider chat", args: ["chat", "say hi"], expect: /\[mock:OpenAI\][\s\S]*say hi/ },
];

try {
  console.log("=== Step-30 integration smoke ===\n");
  for (const c of cases) {
    const out = await runCli(c.args, { ...baseEnv, ...(c.env ?? {}) });
    const ok = out.code === 0 && c.expect.test(out.combined);
    if (ok) {
      pass++;
      console.log(`  PASS  ${c.name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.name}`);
      console.log(`        command: bun ${cli} ${c.args.join(" ")}`);
      console.log(`        exit: ${out.code}`);
      console.log(`        output: ${out.combined.slice(0, 800).replace(/\s+/g, " ")}`);
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
} finally {
  tryRemove(home);
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; combined: string }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
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

function tryRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup; smoke assertions have already completed.
  }
}
