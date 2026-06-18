/**
 * Relevance scoring for the ATP Tool Budget Allocator (step-07).
 *
 * The allocator (`describeTools` in `./describe.ts`) decides, per dispatch,
 * which tools earn the larger `full` description and which stay at the
 * always-safe `lean` one. To pick, it needs a *numeric* relevance score per
 * tool that combines three weak but cheap signals:
 *
 *   - `keywordHit`  — does the message stream mention this tool's triggers
 *                     or any verb associated with its family?
 *   - `lastUseRecency` — was this tool used in the previous round (strong
 *                        signal it will be used again) or the one before?
 *   - `roleAffinity` — does the current agent role have a documented bias
 *                      for this tool (e.g. explorer leans on Glob/Grep)?
 *
 * All three are bounded to `[0, 1]`. The allocator combines them with the
 * weighting from `docs/step-07-tool-budget-allocator.md §2`:
 *
 *     total = 0.6 * keyword + 0.25 * recency + 0.15 * role
 *
 * Design constraints from `docs/innovations.md §1`:
 *   - **No LLM calls.** Scoring must be sync, deterministic, and free.
 *   - **No persistence.** State is per-dispatch only; long-term tool
 *     analytics live in telemetry (`tools.described`), not here.
 *
 * Why not use TF-IDF / embeddings / a tiny classifier? Step-07's risk note
 * says it explicitly: cheap weighted heuristics with telemetry feedback are
 * preferred over a learned model that adds latency, eval surface, and an
 * extra API dependency.
 */

import type { ChatMessage } from "../types/messages.js";
import type { AgentRole } from "../types/agent.js";
import type { Tool } from "../types/tool.js";

// ---------------------------------------------------------------------------
// 1. Verb dictionary (used when a tool sets no `fullTriggers`).
// ---------------------------------------------------------------------------

/**
 * Coarse per-family verb patterns. Each entry is `RegExp[]` so we can mix
 * English and Simplified-Chinese forms cheaply. The dictionary is **not**
 * exhaustive — only common verbs. Tools with niche vocabulary SHOULD set
 * `fullTriggers` to lift them to the 1.0 sticky-hit lane.
 *
 * Adding a new family? Match `ToolFamily` literals in
 * `src/types/tool.ts` exactly so the lookup in `keywordHit` succeeds.
 */
export const VERB_PATTERNS: Record<string, RegExp[]> = {
  fs: [
    /\b(read|cat|view|open|edit|write|modify|create|delete|rm|patch|diff|apply|search|find|grep|ls|glob|file|directory|folder)\b/i,
    /(读|看|打开|改|修改|新建|创建|删除|搜|搜索|查找|查看|文件|目录|文件夹|找文件)/,
  ],
  exec: [
    /\b(run|exec|execute|bash|shell|sh|cmd|command|test|install|build|compile|npm|bun|pnpm|yarn)\b/i,
    /(执行|运行|跑|测试|编译|构建|安装|启动|命令)/,
  ],
  web: [
    /\b(fetch|download|http|https|url|website|page|browse|crawl|api|web|search)\b/i,
    /(抓取|下载|网页|网站|访问|爬|接口|链接|搜一下网|搜网|查网)/,
  ],
  meta: [
    /\b(todo|plan|note|remember|memory|ask|question|checklist)\b/i,
    /(计划|清单|备忘|记忆|询问|提问|问一下)/,
  ],
  // No entries for "echo" / "custom": they fall through to score 0 unless a
  // `fullTriggers` regex hits.
};

/**
 * Soft hit weight. A verb match is weaker evidence than a tool-author
 * `fullTriggers` regex, which is treated as a sticky 1.0 — see `keywordHit`.
 */
const VERB_HIT_WEIGHT = 0.4;

function testPattern(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

// ---------------------------------------------------------------------------
// 2. keywordHit
// ---------------------------------------------------------------------------

/**
 * Score 0..1 reflecting how related the tool looks to the recent message
 * stream. We only inspect user + assistant messages (tool / system are noise
 * for this purpose).
 *
 * Strategy:
 *   - If *any* of `tool.fullTriggers` matches, return `1` immediately. The
 *     tool author has explicitly said "if this string shows up, you want me".
 *   - Otherwise the best we can do is a verb hit against the tool's family
 *     dictionary, which is partial credit (`VERB_HIT_WEIGHT`).
 *
 * Cost: O(M*R) regex tests per tool where M = messages and R = trigger
 * count. The recent-message window is capped by the caller (~8 msgs), so
 * even with 30 tools this is sub-millisecond.
 */
export function keywordHit(tool: Tool, recent: ChatMessage[]): number {
  const triggers = tool.fullTriggers ?? [];
  const family = (tool.family ?? "custom") as string;
  const verbs = VERB_PATTERNS[family] ?? [];

  let best = 0;
  for (const m of recent) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = m.content;
    if (!text) continue;
    for (const re of triggers) {
      if (testPattern(re, text)) return 1; // sticky max
    }
    if (best < VERB_HIT_WEIGHT) {
      for (const re of verbs) {
        if (testPattern(re, text)) {
          best = VERB_HIT_WEIGHT;
          break;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. lastUseRecency
// ---------------------------------------------------------------------------

/**
 * Score 0..1 from how recently this tool was called.
 *
 *   - In the previous round (`lastCalled`):    0.8
 *   - Two rounds ago (`prevCalled`):           0.4
 *   - Neither:                                 0
 *
 * Rationale (per `docs/step-07-tool-budget-allocator.md §2`): tool use is
 * sticky — a model that just called `grep` almost always calls `grep` again
 * (or jumps to `read` next). Giving freshly-used tools a small upgrade
 * bonus keeps the full description on the table when the model needs it.
 */
export function lastUseRecency(
  toolName: string,
  lastCalled: readonly string[],
  prevCalled: readonly string[] = [],
): number {
  if (lastCalled.includes(toolName)) return 0.8;
  if (prevCalled.includes(toolName)) return 0.4;
  return 0;
}

// ---------------------------------------------------------------------------
// 4. roleAffinity
// ---------------------------------------------------------------------------

/**
 * Per-role tool / family bias table. Step-07 spec section 3 spells out the
 * baseline weights; we keep the same numbers verbatim so reviewers can diff
 * against the doc.
 *
 * Lookup order in `roleAffinity()`:
 *   1. Exact tool name (e.g. `glob`, `grep`).
 *   2. Tool family (e.g. `fs` for a custom file tool that isn't in the table).
 *   3. Zero.
 *
 * A role that intentionally has *no* bias (e.g. `main`) maps to an empty
 * record so every tool falls through to 0. This is what gives `main` its
 * neutral "let the keyword / recency signal speak" behavior.
 */
export const ROLE_AFFINITY: Record<AgentRole, Record<string, number>> = {
  main: {},
  explorer: { glob: 0.9, grep: 0.9, read: 0.8, ls: 0.7, bash: 0.2 },
  planner: { todo_write: 0.9, ask_user: 0.6, glob: 0.4, grep: 0.4, read: 0.5 },
  verifier: { bash: 0.9, read: 0.7, grep: 0.6 },
  critic: { read: 0.6, grep: 0.5 },
  "checkpoint-writer": { write: 0.8, read: 0.4 },
  custom: {},
};

/** Score 0..1 from the role's preference for this tool. */
export function roleAffinity(tool: Tool, role: AgentRole): number {
  const table = ROLE_AFFINITY[role] ?? {};
  const byName = table[tool.name];
  if (typeof byName === "number") return byName;
  const fam = tool.family;
  if (fam) {
    const byFamily = table[fam];
    if (typeof byFamily === "number") return byFamily;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 5. Composite score
// ---------------------------------------------------------------------------

/** Breakdown returned by `scoreTool` so the allocator (and tests) can inspect components. */
export interface RelevanceScore {
  keyword: number;
  recency: number;
  role: number;
  /** `0.6 * keyword + 0.25 * recency + 0.15 * role` */
  total: number;
}

const W_KEYWORD = 0.6;
const W_RECENCY = 0.25;
const W_ROLE = 0.15;

/** Convenience: compute all three signals + the weighted total in one call. */
export function scoreTool(
  tool: Tool,
  recent: ChatMessage[],
  lastCalled: readonly string[],
  prevCalled: readonly string[],
  role: AgentRole,
): RelevanceScore {
  const keyword = keywordHit(tool, recent);
  const recency = lastUseRecency(tool.name, lastCalled, prevCalled);
  const r = roleAffinity(tool, role);
  return {
    keyword,
    recency,
    role: r,
    total: W_KEYWORD * keyword + W_RECENCY * recency + W_ROLE * r,
  };
}

// ---------------------------------------------------------------------------
// 6. Round-history helpers
// ---------------------------------------------------------------------------

/**
 * Walk the message tail and return the *penultimate* assistant tool-call
 * round (i.e. the round before the one summarized by `lastToolCalls`).
 *
 * The caller usually passes the most recent round explicitly via
 * `DescribeOptions.lastToolCalls`, so we only have to find the round *before
 * that one*. We do this by walking from the end of the message list and
 * collecting the first two assistant messages with `toolCalls`.
 *
 * Why scan instead of asking the caller for it? Because the agent loop
 * already keeps the canonical history; threading a second array all the
 * way through `queryEngine` → `describeTools` would just duplicate it.
 * Callers MAY override this by passing `prevToolCalls` explicitly.
 */
export function derivePrevToolCalls(recent: ChatMessage[]): string[] {
  const rounds: string[][] = [];
  for (let i = recent.length - 1; i >= 0 && rounds.length < 2; i--) {
    const m = recent[i];
    if (m?.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      rounds.push(m.toolCalls.map((c) => c.name));
    }
  }
  // rounds[0] = most recent (already captured by DescribeOptions.lastToolCalls)
  // rounds[1] = the one before — what we want.
  return rounds[1] ?? [];
}
