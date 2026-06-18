// step-07 ATP smoke test. Runs against the in-memory tool registry; no fs/network.
import { z } from "zod";
import {
  describeTools,
  registerTool,
  resetToolRegistry,
} from "../src/tools/index.js";
import type { Tool } from "../src/types/tool.js";
import { createTelemetrySink, setTelemetrySink } from "../src/telemetry/index.js";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Capture telemetry to a tmp dir so we can grep it at the end.
const tmp = mkdtempSync(join(tmpdir(), "chovy-atp-"));
const sink = createTelemetrySink({ dir: tmp, flushMs: 0 });
setTelemetrySink(sink);

resetToolRegistry();

function mkTool(
  name: string,
  family: "fs" | "exec" | "web" | "meta",
  opts: { triggers?: RegExp[]; leanLen?: number; fullLen?: number } = {},
): Tool {
  const leanLen = opts.leanLen ?? 200; // ~50 tokens
  const fullLen = opts.fullLen ?? 800; // ~200 tokens
  return {
    name,
    version: 2,
    family,
    desc: {
      lean: `Lean desc for ${name}. `.repeat(Math.max(1, Math.floor(leanLen / 24))),
      full: `Full description of ${name} with edge cases. `.repeat(
        Math.max(1, Math.floor(fullLen / 48)),
      ),
    },
    fullTriggers: opts.triggers,
    schema: z.object({ q: z.string() }),
    isReadOnly: true,
    canUseWithoutAsk: true,
    async run(args) {
      return { ok: true, content: `${name}:${args.q}` };
    },
  };
}

// 25 synthetic tools: 4 fs (glob/grep/read/edit), 1 exec (bash), 1 web (fetch),
// 19 misc meta-namespaced. Sizes are realistic-ish (50/200 tokens).
const tools: Tool[] = [
  mkTool("glob", "fs", { triggers: [/\.ts\b/, /所有.*文件/] }),
  mkTool("grep", "fs", { triggers: [/search|找/i] }),
  mkTool("read", "fs", { triggers: [/read|看/i] }),
  mkTool("edit", "fs", { triggers: [/edit|改/i] }),
  mkTool("write", "fs", { triggers: [/write|写/i] }),
  mkTool("bash", "exec", { triggers: [/run|exec/i] }),
  mkTool("web_fetch", "web", { triggers: [/fetch|http/i] }),
];
for (let i = 0; i < 18; i++) {
  tools.push(mkTool(`misc_${i}`, "meta"));
}
for (const t of tools) registerTool(t, { namespace: t.family });

// --- Case A: budget=2k, "搜下所有 .ts 文件" → expect glob full, others lean ---
const a = describeTools({
  budgetTokens: 2000,
  recentMessages: [{ role: "user", content: "搜下所有 .ts 文件" }],
  lastToolCalls: [],
  agentRole: "explorer",
});
const aFulls = a.filter((d) => d.level === "full").map((d) => d.name);
console.log("CASE A (budget=2k, .ts query):");
console.log("  total=", a.length, " full=", aFulls);

// --- Case B: edit + write same family → only one full ---
const b = describeTools({
  budgetTokens: 4000,
  recentMessages: [
    { role: "user", content: "edit src/foo.ts and write a new test" },
  ],
  lastToolCalls: [],
  agentRole: "main",
});
const bFulls = b.filter((d) => d.level === "full").map((d) => d.name);
const bFsFulls = bFulls.filter((n) => ["edit", "write", "glob", "grep", "read"].includes(n));
console.log("CASE B (edit+write, family exclusivity):");
console.log("  fs full=", bFsFulls, " (must be length 1)");

// --- Case C: budget=100 (too tight) → all lean ---
const c = describeTools({
  budgetTokens: 100,
  recentMessages: [{ role: "user", content: "search all .ts files" }],
  lastToolCalls: ["glob"],
  agentRole: "explorer",
});
const cFulls = c.filter((d) => d.level === "full").map((d) => d.name);
console.log("CASE C (budget=100, way too tight):");
console.log("  total=", c.length, " full=", cFulls, " (must be empty if lean alone overshoots)");

// --- Case D: empty messages + no recency → no upgrade ---
const d = describeTools({
  budgetTokens: 5000,
  recentMessages: [],
  lastToolCalls: [],
  agentRole: "main",
});
const dFulls = d.filter((x) => x.level === "full").map((x) => x.name);
console.log("CASE D (empty msgs, no recency):");
console.log("  full=", dFulls, " (must be empty: no relevance signal)");

// --- Case E: role affinity → explorer biases glob/grep/read ---
const e = describeTools({
  budgetTokens: 5000,
  recentMessages: [{ role: "user", content: "just chat" }],
  lastToolCalls: [],
  agentRole: "explorer",
});
const eFulls = e.filter((x) => x.level === "full").map((x) => x.name);
console.log("CASE E (explorer role, neutral msg):");
console.log("  full=", eFulls, " (expect glob/grep/read picked, one fs)");

// --- flush + verify telemetry ---
sink.close();
const files = readdirSync(tmp).filter((f) => f.endsWith(".jsonl"));
let described = 0;
for (const f of files) {
  const lines = readFileSync(join(tmp, f), "utf8").split("\n").filter(Boolean);
  for (const l of lines) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "tools.described") described++;
    } catch { /* ignore */ }
  }
}
console.log("TELEMETRY: tools.described events written =", described, " (expect 5)");
console.log("TMP DIR:", tmp);
