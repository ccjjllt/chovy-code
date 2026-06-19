/**
 * CSG — Conditional Skill Graph contracts (frozen at step-29).
 *
 * Skills form a DAG where edges are declared as `requires` (incoming) /
 * `provides` (outgoing capability tokens). The Skill Planner
 * (`src/skills/planner.ts`) walks this graph to inject the minimum viable
 * subset given the current user intent, respecting `ContextBudget.skills`.
 *
 * Field names align with `docs/step-29-skill-graph.md` §"Skill 接口". The
 * earlier draft (`id` / `body` / `match` / `approxTokens`) was a placeholder
 * shipped during step-28 prep; it had zero in-tree consumers, so step-29
 * lands the canonical names directly. AGENTS.md §I.frozen-extension applies
 * to *post*-step-29 changes (extensions only — no rename / delete).
 *
 * Why these names?
 *   - `name`: canonical identifier (matches the slash command and tool arg).
 *   - `summary`: a single line shown by `chovy skill list` and `desc.lean`.
 *   - `triggers`: planner inputs (keywords / regexes / activation policy);
 *      mirrors `Tool.fullTriggers` so the same intuitions transfer.
 *   - `systemFragment`: the markdown injected into the prompt when active —
 *     read by `prompts/snippets.ts:skillFragmentsSection`.
 *   - `budgetTokens`: self-reported cost. The planner enforces
 *     `Σ budgetTokens ≤ ContextBudget.skills` (default 8000;
 *      `src/context/budgets.ts:DEFAULT_SLABS`).
 *   - `requires` / `provides` / `conflicts`: the graph edges that turn this
 *     module into CSG (cc-haha lacks all three; this is the differentiator).
 */

/**
 * Trigger heuristic for the planner. All fields are optional; when none are
 * set the skill is *manual-only* (the planner ignores it; only SkillTool /
 * `/skill <name>` activates it).
 */
export interface SkillTriggers {
  /** Lowercased substrings that bump score by +1 each when found in the
   *  latest user text. Matched whole-word case-insensitive (the planner
   *  lower-cases both sides). */
  keywords?: string[];
  /** Compiled regexes that bump score by +1 each on match. Use sparingly —
   *  prefer `keywords` for stable scoring. The planner resets `lastIndex`
   *  before each test (AGENTS.md §16 ATP guard). */
  patterns?: RegExp[];
  /**
   * Activation timing.
   *  - `'on-request'` (default): planner considers this skill on every round.
   *  - `'pre-tool'`: same as `on-request` but score gated on a tool-call
   *    happening last round (encourages "wrap a tool" workflows like format).
   *  - `'always'`: always activated (score = +∞), bypasses keyword scoring.
   *    Use for system-wide skills.
   */
  when?: "on-request" | "pre-tool" | "always";
}

/**
 * A single skill definition. Bundled in `src/skills/bundled/*` and (later;
 * step-30) loaded from `~/.chovy/skills/<name>/SKILL.md`.
 */
export interface Skill {
  /** Stable name. Used as graph node key, slash command suffix, and
   *  SkillTool's `skill` arg value. Convention: kebab-case. */
  name: string;
  /** One-line description shown by `chovy skill list` and used as the
   *  lean blurb when the planner mentions the skill. */
  summary: string;
  /** Planner inputs — see `SkillTriggers`. */
  triggers: SkillTriggers;
  /** Skill names this skill depends on. Resolved by BFS closure. Missing
   *  required → planner skips the skill (auto) or SkillTool refuses with
   *  `TOOL_DENIED` (manual). */
  requires?: string[];
  /** Capability tokens this skill exposes once activated. The planner uses
   *  these for `provides_overlap_with_goal` scoring (+0.5 each). */
  provides?: string[];
  /** Skill names this skill cannot coexist with. Same-conflict-group
   *  resolution keeps the highest score; SkillTool refuses with
   *  `TOOL_DENIED` if a manual activation collides with an active conflict. */
  conflicts?: string[];
  /** Markdown body injected into the prompt as a `<skill name="...">` block.
   *  Should be self-contained (the model has no other context for this
   *  skill). Aim for `≤ budgetTokens * 4` characters. */
  systemFragment: string;
  /** Self-reported token cost. Planner enforces total against
   *  `ContextBudget.skills` (default 8000). Use a 4-chars/token estimate
   *  and round generously. */
  budgetTokens: number;
}

/**
 * A node in the resolved planning graph (step-29). The planner builds these
 * from the registered `Skill[]`, then prunes by score / conflict / budget.
 *
 * Frozen at step-29 — extensions add optional fields only.
 */
export interface SkillNode {
  /** The underlying skill definition. */
  skill: Skill;
  /** Activation score from the planner. Higher = more relevant.
   *  Manual activations get +999 to lock them above keyword-driven ones. */
  score: number;
}
