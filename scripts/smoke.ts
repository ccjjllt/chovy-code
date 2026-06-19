/**
 * Step-30 integration smoke.
 *
 * Offline by default: `CHOVY_E2E_USE_MOCK=1` makes provider calls return a
 * deterministic local response. Each run uses a temp CHOVY_HOME so memory,
 * telemetry, and config state do not leak into the user's real home.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

interface Case {
  name: string;
  args: string[];
  expect: RegExp;
  expectedCode?: number;
  env?: Record<string, string>;
  assert?: (out: { code: number; stdout: string; stderr: string; combined: string }) => void;
}

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src", "cli", "index.tsx");
const home = mkdtempSync(join(tmpdir(), "chovy-smoke-"));
const binHashBefore = hashIfExists(join(root, "bin", "chovy.js"));
const configSmokeKey = "chovy_smoke_secret_value";

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
  { name: "config help", args: ["config", "--help"], expect: /--provider[\s\S]*--key[\s\S]*--non-interactive/ },
  { name: "goal help", args: ["goal", "--help"], expect: /--max-rounds[\s\S]*--budget-usd/ },
  { name: "provider list", args: ["provider", "list"], expect: /anthropic[\s\S]*glm[\s\S]*openai/ },
  {
    name: "config non-interactive",
    args: [
      "config",
      "--provider",
      "glm",
      "--model",
      "glm-4.5",
      "--permission-mode",
      "plan",
      "--key",
      configSmokeKey,
      "--non-interactive",
    ],
    expect: /Configuration saved[\s\S]*provider=glm[\s\S]*key=configured/,
    assert: (out) => {
      if (out.combined.includes(configSmokeKey)) {
        throw new Error("config command leaked the API key to stdout/stderr");
      }
      const cfgPath = join(home, "config.json");
      const secretPath = join(home, "secrets", "glm");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      if (cfg["provider"] !== "glm") throw new Error("config provider was not written");
      if (cfg["model"] !== "glm-4.5") throw new Error("config model was not written");
      if (cfg["permissionMode"] !== "plan") throw new Error("config permissionMode was not written");
      if (JSON.stringify(cfg).includes(configSmokeKey)) {
        throw new Error("API key was written into config.json");
      }
      const secret = readFileSync(secretPath, "utf8");
      if (secret !== configSmokeKey) {
        throw new Error("secret file did not contain exactly the API key");
      }
    },
  },
  {
    name: "config non-tty guard",
    args: ["config"],
    expectedCode: 1,
    expect: /requires an interactive TTY[\s\S]*config\.json[\s\S]*secrets/,
  },
  { name: "skill list", args: ["skill", "list"], expect: /commit[\s\S]*review[\s\S]*ts-fix/ },
  {
    name: "mem write",
    args: ["mem", "write", "we use Bun + Ink", "--layer", "project", "--type", "decision", "--importance", "90"],
    expect: /memory written: project\/decision/,
  },
  { name: "mem search", args: ["mem", "search", "Bun Ink"], expect: /Bun \+ Ink/ },
  {
    name: "mock provider chat",
    args: ["chat", "say hi"],
    expect: /\[mock:OpenAI\][\s\S]*say hi/,
    env: { CHOVY_PROVIDER: "openai" },
  },
];

try {
  console.log("=== Step-30 integration smoke ===\n");
  for (const c of cases) {
    const out = await runCli(c.args, { ...baseEnv, ...(c.env ?? {}) });
    let assertionError: Error | undefined;
    try {
      c.assert?.(out);
    } catch (err) {
      assertionError = err instanceof Error ? err : new Error(String(err));
    }
    const ok = out.code === (c.expectedCode ?? 0) && c.expect.test(out.combined) && !assertionError;
    if (ok) {
      pass++;
      console.log(`  PASS  ${c.name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.name}`);
      console.log(`        command: bun ${cli} ${c.args.join(" ")}`);
      console.log(`        exit: ${out.code}`);
      console.log(`        output: ${out.combined.slice(0, 800).replace(/\s+/g, " ")}`);
      if (assertionError) {
        console.log(`        assertion: ${assertionError.message}`);
      }
    }
  }

  const binHashAfter = hashIfExists(join(root, "bin", "chovy.js"));
  if (binHashBefore !== binHashAfter) {
    fail++;
    console.log("  FAIL  bin artifact unchanged");
    console.log("        bin/chovy.js hash changed during smoke");
  } else {
    pass++;
    console.log("  PASS  bin artifact unchanged");
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

function hashIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
