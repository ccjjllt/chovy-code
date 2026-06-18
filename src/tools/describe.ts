/**
 * ATP — Adaptive Tool Protocol — runtime allocator (step-07).
 *
 * Replaces the step-06 stub. Picks per-tool lean/full descriptions based on:
 *   - a relevance score per tool (see `./relevance.ts`),
 *   - the caller's `budgetTokens` cap,
 *   - same-family `full` exclusivity (one full per family),
 *   - a top-K candidate cap when the tool pool grows large,
 *   - a graceful drop path when even the lean baseline blows the budget.
 *
 * The `DescribeOptions` / `DescribedTool` *types* are frozen since step-06
 * (B1 barrier). Step-07 adds new **optional** fields only — existing
 * callers (today: nothing in tree, tomorrow: the query engine in step-16)
 * continue to compile unchanged.
 *
 * Each dispatch emits one `tools.described` telemetry event so we can audit
 * lean/full ratios and dropped tools without a runtime debugger.
 *
 * Per `docs/innovations.md §1`, ATP MUST NOT:
 *   - call an LLM to "judge" relevance (cost, latency, eval surface),
 *   - persist scoring state between dispatches (would silently bias),
 *   - touch the JSON schemas — they are always fully injected.
 */

import type { ChatMessage } from "../types/messages.js";
import type { AgentRole } from "../types/agent.js";
import type { Tool } from "../types/tool.js";
import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { listTools } from "./registry.js";
import { derivePrevToolCalls, scoreTool } from "./relevance.js";

// ---------------------------------------------------------------------------
// Frozen public surface (step-06)
// ---------------------------------------------------------------------------

/** Inputs the allocator needs to choose lean vs full per tool. */
export interface DescribeOptions {
  /** Total token budget the allocator may spend on tool descriptions. */
  budgetTokens: number;
  /** Recent user/assistant messages, freshest last. Cap ~8 at the caller. */
  recentMessages: ChatMessage[];
  /** Tool names called in the previous round (boost their relevance). */
  lastToolCalls: string[];
  /**
   * Optional explicit tool filter. When set, only these tools are described
   * — useful for sub-agents with a tool whitelist (step-19).
   */
  only?: string[];

  // ── step-07 additions (all optional; safe for step-06 call sites) ─────────

  /**
   * Active agent role; drives the role-affinity table in `relevance.ts`.
   * Defaults to `"main"` (no role bias) when absent.
   */
  agentRole?: AgentRole;

  /**
   * Token estimator. Defaults to a chars/4 heuristic. Step-17's PCM will
   * pass a provider-specific tokenizer here when one is available.
   */
  modelTokenizer?: (s: string) => number;

  /**
   * Tool names from the *penultimate* round (two rounds back). When absent,
   * derived from `recentMessages` by scanning assistant `toolCalls`.
   */
  prevToolCalls?: string[];
}

/** Output of the allocator — exactly what gets injected into the prompt. */
export interface DescribedTool {
  name: string;
  /** The string actually emitted (lean or full body, examples inlined). */
  description: string;
  /** JSON-Schema-like representation of the tool's args. */
  schemaJson: unknown;
  /** Which level the allocator picked. */
  level: "lean" | "full";
}

// ---------------------------------------------------------------------------
// Tunables — kept as named constants so step-30 unit tests can pin them.
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

/**
 * When more than this many tools are registered, the candidate set for
 * `full` upgrades is capped at top-K (K derived from the average full
 * cost). The intent is to keep one rogue megaproject with 200 tools from
 * paying O(N) tokens for poorly-relevant candidates that will lose to
 * better ones anyway.
 */
const TOP_K_THRESHOLD = 30;

/** Fallback for K's denominator when every tool reports `fullCost === 0`. */
const AVG_FULL_TOKENS_FALLBACK = 250;

/**
 * Score floor below which a tool is *never* upgraded to `full`, even if
 * budget allows. Zero relevance means we'd be paying tokens for noise.
 * Set it just above `0` so a pure-recency hit (0.25 * 0.4 = 0.1) still
 * upgrades when applicable.
 */
const MIN_SCORE_FOR_UPGRADE = 0.05;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function defaultTokenize(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function leanText(t: Tool): string {
  return t.desc?.lean ?? t.description ?? "";
}

/**
 * Assemble the full text actually injected when a tool is upgraded.
 * Examples ride along with `full` per `docs/innovations.md §1.2`; if the
 * caller wants to drop them, they need to author a smaller `full`.
 */
function fullText(t: Tool): string {
  const base = t.desc?.full ?? t.desc?.lean ?? t.description ?? "";
  const ex = t.desc?.examples;
  if (!ex || ex.length === 0) return base;
  return `${base}\n\nExamples:\n${ex.map((e) => `  - ${e}`).join("\n")}`;
}

function schemaJsonOf(t: Tool): unknown {
  const s = t.schema as unknown as { toJSON?: () => unknown };
  return s.toJSON?.() ?? { type: "object" };
}

// ---------------------------------------------------------------------------
// Allocator
// ---------------------------------------------------------------------------

interface WorkItem {
  tool: Tool;
  leanText: string;
  fullText: string;
  leanCost: number;
  fullCost: number;
  score: number;
}

/**
 * Pick lean/full descriptions for every registered (or filtered) tool so the
 * total token cost stays within `opts.budgetTokens`. The signature is
 * frozen since step-06; the body is the real ATP allocator.
 */
export function describeTools(opts: DescribeOptions): DescribedTool[] {
  const all = listTools({ enabled: true });
  const pool: Tool[] = opts.only
    ? all.filter((t) => opts.only!.includes(t.name))
    : all;

  const role: AgentRole = opts.agentRole ?? "main";
  const tokenize = opts.modelTokenizer ?? defaultTokenize;
  const prevCalled = opts.prevToolCalls ?? derivePrevToolCalls(opts.recentMessages);

  // -- Step 1: score every tool and compute lean/full cost up-front. --------
  let items: WorkItem[] = pool.map((t) => {
    const ln = leanText(t);
    const fl = fullText(t);
    return {
      tool: t,
      leanText: ln,
      fullText: fl,
      leanCost: tokenize(ln),
      fullCost: tokenize(fl),
      score: scoreTool(t, opts.recentMessages, opts.lastToolCalls, prevCalled, role).total,
    };
  });

  // -- Step 2: if the lean baseline alone overshoots the budget, drop the ---
  // -- lowest-scoring tools (with a warning) until we fit.                ---
  const droppedNames: string[] = [];
  let leanTotal = items.reduce((sum, w) => sum + w.leanCost, 0);
  if (leanTotal > opts.budgetTokens && opts.budgetTokens > 0 && items.length > 0) {
    const byScoreAsc = [...items].sort((a, b) =>
      a.score === b.score ? b.leanCost - a.leanCost : a.score - b.score,
    );
    const surviving = new Set(items.map((w) => w.tool.name));
    while (leanTotal > opts.budgetTokens && byScoreAsc.length > 0) {
      const drop = byScoreAsc.shift();
      if (!drop) break;
      droppedNames.push(drop.tool.name);
      surviving.delete(drop.tool.name);
      leanTotal -= drop.leanCost;
    }
    items = items.filter((w) => surviving.has(w.tool.name));
    logger.warn("ATP: lean baseline exceeded budget; dropped low-relevance tools", {
      errorCode: "TOOL_BUDGET",
      budgetTokens: opts.budgetTokens,
      droppedNames,
      remaining: items.length,
    });
  }

  // -- Step 3: initial lean output. -----------------------------------------
  const out: DescribedTool[] = items.map((w) => ({
    name: w.tool.name,
    description: w.leanText,
    schemaJson: schemaJsonOf(w.tool),
    level: "lean",
  }));

  // -- Step 4: greedy upgrade by score desc, respecting headroom + family. --
  let upgradeBudget = opts.budgetTokens - leanTotal;
  const upgradedFamilies = new Set<string>();

  if (upgradeBudget > 0 && items.length > 0) {
    // Build the upgrade-candidate set: relevance > floor AND full actually
    // bigger than lean (otherwise upgrade is a no-op).
    let candidates = items.filter(
      (w) => w.score >= MIN_SCORE_FOR_UPGRADE && w.fullCost > w.leanCost,
    );

    // Boundary protection: cap candidates at top-K when the pool is huge.
    if (items.length > TOP_K_THRESHOLD) {
      const avg =
        items.reduce((s, w) => s + w.fullCost, 0) / Math.max(1, items.length) ||
        AVG_FULL_TOKENS_FALLBACK;
      const k = Math.max(1, Math.floor(upgradeBudget / Math.max(1, avg)));
      candidates = [...candidates]
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    }

    const ranked = [...candidates].sort((a, b) =>
      b.score === a.score ? a.fullCost - b.fullCost : b.score - a.score,
    );

    for (const w of ranked) {
      if (upgradeBudget <= 0) break;
      const fam = w.tool.family;
      // Same-family exclusivity: one full per family per dispatch.
      if (fam && upgradedFamilies.has(fam)) continue;
      const delta = w.fullCost - w.leanCost;
      if (delta > upgradeBudget) continue;
      const slot = out.find((d) => d.name === w.tool.name);
      if (!slot) continue;
      slot.description = w.fullText;
      slot.level = "full";
      upgradeBudget -= delta;
      if (fam) upgradedFamilies.add(fam);
    }
  }

  // -- Step 5: telemetry. ---------------------------------------------------
  const fullCount = out.reduce((n, d) => n + (d.level === "full" ? 1 : 0), 0);
  emitTelemetry({
    type: "tools.described",
    total: out.length,
    full: fullCount,
    lean: out.length - fullCount,
    droppedCount: droppedNames.length,
    budgetTokens: opts.budgetTokens,
    upgradeBudgetRemaining: Math.max(0, upgradeBudget),
    role,
  });

  return out;
}
