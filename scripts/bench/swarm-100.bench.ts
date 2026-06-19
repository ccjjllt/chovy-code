import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { ParentRuntimeCtx, Provider } from "../../src/types/index.js";

const thresholdMs = 800;
const home = mkdtempSync(join(tmpdir(), "chovy-bench-swarm-home-"));
process.env["CHOVY_HOME"] = home;
process.env["CHOVY_MEMORY_ENABLED"] = "0";
process.env["CHOVY_CTX_DISABLE"] = "1";
process.env["CHOVY_SKILLS_AUTO"] = "0";

try {
  const { dispatch } = await import("../../src/swarm/index.js");
  const { registerProvider, _unregisterProviderForTesting } = await import("../../src/providers/index.js");
  const { _resetSubAgentPoolForTesting } = await import("../../src/agent/index.js");

  const prev = _unregisterProviderForTesting("openai");
  registerProvider(mockProvider());
  _resetSubAgentPoolForTesting();

  const parent: ParentRuntimeCtx = {
    parentId: "bench-main",
    parentRole: "main",
    parentProvider: "openai",
    parentModel: "bench-model",
    parentMode: "bypassPermissions",
    parentMessages: [],
  };

  const t0 = performance.now();
  const out = await dispatch({
    prompts: Array.from({ length: 100 }, (_, i) => ({
      id: `a${i}`,
      prompt: `bench task ${i}`,
      provider: "openai" as const,
      model: "bench-model",
    })),
    parallelism: 100,
    budgetUSD: 100,
  }, parent);
  const durMs = performance.now() - t0;

  _unregisterProviderForTesting("openai");
  if (prev) registerProvider(prev);
  _resetSubAgentPoolForTesting();

  const status = durMs <= thresholdMs ? "PASS" : "WARN";
  console.log(`${status} Swarm spawn 100 (mocked LLM): ${durMs.toFixed(2)}ms (threshold ${thresholdMs}ms) results=${out.results.length}`);
} finally {
  tryRemove(home);
}

function mockProvider(): Provider {
  return {
    info: {
      id: "openai",
      label: "Bench OpenAI",
      envKey: "OPENAI_API_KEY",
      defaultModel: "bench-model",
      supportsStreaming: false,
      supportsTools: false,
    },
    assertReady: () => {},
    complete: async () => ({
      content: "ok",
      toolCalls: [],
      usage: { prompt: 1, completion: 1 },
    }),
  };
}

function tryRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup; benchmark result should not depend on it.
  }
}
