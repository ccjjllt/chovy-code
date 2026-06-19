/**
 * Intent extraction (step-29 — CSG planner input).
 *
 * Produces a `tags[]` list from the latest user message, recent message
 * tail, and (when available) the active goal objective. Tags are simply
 * lower-cased capability tokens and verb stems — the planner uses them to
 * score candidate skills against `triggers.keywords` and `provides`.
 *
 * Why rule-based (no LLM)?
 *   - Per spec §风险: "意图抽取偏差大 → 第一版用规则；后续可加 small-model 评分".
 *   - Runs every round on the hot path; an LLM call would dominate latency.
 *   - Deterministic = easier to test, easier to debug "why did the planner
 *     pick X but not Y".
 *
 * Future step-30 may add a `score(skill, tags, ctx)` LLM hook in the planner;
 * this module stays pure-text.
 */

import type { ChatMessage } from "../types/messages.js";

export interface IntentInput {
  /** The most recent user message text (head of the planner round). */
  latestUserText: string;
  /** Up to N recent messages (tool calls included). Used to detect implicit
   *  intent — e.g. a recent `git diff` tool call implies commit intent. */
  recentMessages?: ChatMessage[];
  /** Active goal objective (when invoked from `/goal`). Tokens here weight
   *  `provides_overlap_with_goal` scoring in the planner. */
  goalObjective?: string;
}

export interface IntentResult {
  /** Lower-cased intent tokens. May contain duplicates — the planner
   *  scores by hit count so duplicates legitimately bump weight. */
  tags: string[];
  /** Lower-cased tokens from the goal objective. Scored separately at +0.5
   *  per match against `Skill.provides`. */
  goalTokens: string[];
  /** True iff a recent tool call hinted at git/diff/format/test workflows.
   *  The planner uses this to bump `pre-tool` triggered skills. */
  hasRecentToolHint: boolean;
}

/**
 * Imperative verbs that indicate concrete intent. Augments naïve keyword
 * matching by recognizing verb-stem variants ("committed" → "commit").
 */
const VERB_STEMS: Record<string, string[]> = {
  commit: ["commit", "committed", "committing", "提交"],
  review: ["review", "reviewed", "reviewing", "审查", "评审", "review"],
  refactor: ["refactor", "refactored", "refactoring", "重构"],
  format: ["format", "formatted", "formatting", "lint", "linted", "格式化"],
  test: ["test", "tests", "tested", "testing", "测试"],
  pr: ["pr", "pull request", "pull-request", "合并请求", "merge request"],
  typecheck: [
    "typecheck",
    "type-check",
    "tsc",
    "ts error",
    "ts errors",
    "类型错误",
    "类型检查",
  ],
  fix: ["fix", "fixed", "fixing", "修复", "修", "调试", "bug"],
};

/** Tool calls / outputs that imply intent without the user saying so. */
const TOOL_INTENT_HINTS: Record<string, string[]> = {
  bash: ["commit", "test", "format", "typecheck"], // depends on cmd, expanded below
  file_edit: ["refactor", "fix"],
  file_write: ["refactor", "fix"],
  glob: [],
  grep: [],
};

/** bash command substrings → implicit intent tokens. */
const BASH_CMD_HINTS: Array<{ pattern: RegExp; tags: string[] }> = [
  { pattern: /\bgit\s+(diff|status|log)\b/i, tags: ["commit"] },
  { pattern: /\bgit\s+commit\b/i, tags: ["commit"] },
  { pattern: /\bgit\s+push\b/i, tags: ["pr"] },
  { pattern: /\b(npm|bun|yarn)\s+test\b/i, tags: ["test"] },
  { pattern: /\b(npm|bun|yarn)\s+run\s+typecheck\b/i, tags: ["typecheck"] },
  { pattern: /\btsc\b/i, tags: ["typecheck"] },
  { pattern: /\b(prettier|eslint|biome)\b/i, tags: ["format"] },
  { pattern: /\bgh\s+pr\b/i, tags: ["pr"] },
];

function tokenize(text: string): string[] {
  if (!text) return [];
  // Lower-case + split on whitespace and common punctuation, keeping CJK
  // sequences intact (so '提交' stays one token rather than per-char).
  return text
    .toLowerCase()
    .split(/[\s,;:!?(){}\[\]'"`]+/u)
    .filter((s) => s.length > 0);
}

function expandVerbStems(text: string, out: string[]): void {
  const lc = text.toLowerCase();
  for (const [stem, variants] of Object.entries(VERB_STEMS)) {
    for (const v of variants) {
      // word-boundary match for ASCII, substring for CJK (which lacks \b).
      const isCJK = /[\u4e00-\u9fff]/u.test(v);
      if (isCJK) {
        if (lc.includes(v)) {
          out.push(stem);
          break;
        }
      } else {
        const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(text)) {
          out.push(stem);
          break;
        }
      }
    }
  }
}

export function extractIntent(input: IntentInput): IntentResult {
  const tags: string[] = [];

  // Primary: latest user text (verb stems + naive tokens for keyword match).
  expandVerbStems(input.latestUserText, tags);
  // Add raw tokens too — helps when a skill's keyword exactly equals a noun
  // ("commit message", "format file") that the verb-stem table missed.
  tags.push(...tokenize(input.latestUserText));

  // Recent messages: scan for tool-call hints.
  let hasRecentToolHint = false;
  if (input.recentMessages?.length) {
    // Look at last ~6 messages.
    const slice = input.recentMessages.slice(-6);
    for (const msg of slice) {
      // Tool calls embedded in assistant messages.
      if (msg.toolCalls?.length) {
        for (const call of msg.toolCalls) {
          const hints = TOOL_INTENT_HINTS[call.name];
          if (hints && hints.length > 0) {
            tags.push(...hints);
            hasRecentToolHint = true;
          }
          if (call.name === "bash") {
            // Decode arguments → command substring scan.
            try {
              const parsed = JSON.parse(call.arguments) as { command?: string };
              const cmd = parsed?.command ?? "";
              for (const { pattern, tags: hintTags } of BASH_CMD_HINTS) {
                pattern.lastIndex = 0;
                if (pattern.test(cmd)) {
                  tags.push(...hintTags);
                  hasRecentToolHint = true;
                }
              }
            } catch {
              /* malformed args — skip */
            }
          }
        }
      }
      // Tool RESULT messages (e.g. failed typecheck output).
      if (msg.role === "tool" && msg.content) {
        const lc = msg.content.toLowerCase();
        if (lc.includes("error ts") || lc.includes("typescript error")) {
          tags.push("typecheck", "fix");
          hasRecentToolHint = true;
        }
      }
    }
  }

  const goalTokens = input.goalObjective
    ? tokenize(input.goalObjective)
    : [];
  // Verb stems from goal too — same pattern as user text.
  if (input.goalObjective) {
    expandVerbStems(input.goalObjective, goalTokens);
  }

  return { tags, goalTokens, hasRecentToolHint };
}
