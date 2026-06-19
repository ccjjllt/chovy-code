import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { ChatMessage, ContextBudget } from "../../src/types/index.js";
import type { ChovyConfig } from "../../src/config/index.js";

const thresholdMs = 50;
const home = mkdtempSync(join(tmpdir(), "chovy-bench-context-home-"));
const cwd = mkdtempSync(join(tmpdir(), "chovy-bench-context-cwd-"));
process.env["CHOVY_HOME"] = home;

try {
  const { ensureHomeDirs, ensureProjectDirs } = await import("../../src/fs/index.js");
  const { rebuildContext } = await import("../../src/context/index.js");
  ensureHomeDirs();
  ensureProjectDirs(cwd);

  const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn ${i} ` + "context ".repeat(1400),
    ts: Date.now() - (60 - i) * 1000,
  }));

  const budget: ContextBudget = Object.freeze({
    systemBase: 1500,
    memory: 2000,
    checkpoint: 2000,
    notes: 1000,
    taskProgress: 1000,
    skills: 4000,
    tools: 4000,
    history: 30000,
  });

  const t0 = performance.now();
  const out = await rebuildContext({
    messages,
    cwd,
    sessionId: "bench-context",
    provider: "openai",
    model: "gpt-4o-mini",
    cfg: config(),
    triggeringTokens: 200_000,
    budgetOverride: budget,
  });
  const durMs = performance.now() - t0;

  const status = durMs <= thresholdMs ? "PASS" : "WARN";
  console.log(`${status} Context rebuild (200k -> 30k): ${durMs.toFixed(2)}ms (threshold ${thresholdMs}ms) approxTokens=${out.approxTokens} dropped=${out.dropped}`);
} finally {
  tryRemove(home);
  tryRemove(cwd);
}

function config(): ChovyConfig {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 4096,
    verbose: false,
    permissionMode: "default",
    swarm: { parallelism: 8, maxSubAgents: 100, budgetUSD: 5 },
    memory: { enabled: true, injectBudgetTokens: 4096 },
    context: {
      softRatio: 0.75,
      hardRatio: 0.9,
      reserveTokens: 2048,
    },
    theme: { name: "ChovyDefault", custom: {} }
  } as any;
}

function tryRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Windows may keep SQLite/telemetry handles alive briefly after process
    // work finishes. Bench results are independent from temp-dir cleanup.
  }
}
