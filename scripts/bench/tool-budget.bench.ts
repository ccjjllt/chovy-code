import { performance } from "node:perf_hooks";

import { describeTools } from "../../src/tools/index.js";
import type { ChatMessage } from "../../src/types/index.js";

const thresholdMs = 5;
const recentMessages: ChatMessage[] = [
  { role: "user", content: "grep the src tree, edit TypeScript files, then run tests", ts: Date.now() },
];

// Warm up registry and zod schema conversion.
describeTools({ budgetTokens: 2000, recentMessages, lastToolCalls: [] });

const t0 = performance.now();
const described = describeTools({
  budgetTokens: 2000,
  recentMessages,
  lastToolCalls: [],
  agentRole: "main",
});
const durMs = performance.now() - t0;

report("ATP describe (25 tools, budget 2k)", durMs, thresholdMs, {
  total: described.length,
  full: described.filter((d) => d.level === "full").length,
  lean: described.filter((d) => d.level === "lean").length,
});

function report(
  name: string,
  durMs: number,
  threshold: number,
  meta: Record<string, unknown>,
): void {
  const status = durMs <= threshold ? "PASS" : "WARN";
  console.log(`${status} ${name}: ${durMs.toFixed(2)}ms (threshold ${threshold}ms) ${JSON.stringify(meta)}`);
}
