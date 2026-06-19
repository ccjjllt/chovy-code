/**
 * Skill Planner (step-29 — CSG).
 *
 * Pipeline (`docs/step-29-skill-graph.md` §"Planner 流程"):
 *
 *   1. intent extraction          — `./intentExtractor.ts:extractIntent`
 *   2. score skills               — keywords + provides×goal + manual lock
 *   3. seed = top scorers (>0)
 *   4. dependency closure         — `./graph.ts:computeClosure`
 *   5. conflict resolution        — `./graph.ts:resolveConflicts`
 *   6. budget enforce             — `./graph.ts:enforceBudget`
 *   7. fingerprint + lock writeback (caller — `./lock.ts`)
 *
 * Stays sync + pure (registry snapshot + intent input → plan output) so it's
 * trivially testable. Telemetry / persistence happens in
 * `src/engine/skillHook.ts:runSkillRound`.
 *
 * Scoring formula (matches spec line 71):
 *
 *   score(skill, intent) = matched_keyword_count * 1.0
 *                       + provides_overlap_with_goal * 0.5
 *                       + (manual_lock ? +999 : 0)
 *                       + ('always' trigger ? +500 : 0)
 *                       + ('pre-tool' trigger && hasRecentToolHint ? +0.5 : 0)
 *                       + (regex pattern hit ? +1.0 each : 0)
 *
 * `manual_lock` is checked against `manualNames` — names already in
 * `ToolSession.manualSkillNames` from prior rounds or this round's SkillTool
 * invocation. They survive replanning regardless of intent.
 */

import { createHash } from "node:crypto";
import type { Skill, SkillNode } from "../types/skill.js";
import { extractIntent, type IntentResult } from "./intentExtractor.js";
import {
  computeClosure,
  enforceBudget,
  resolveConflicts,
} from "./graph.js";

export interface PlanInput {
  /** Latest user message (drives keyword/regex scoring). */
  latestUserText: string;
  /** Recent message tail (for tool-call intent hints). */
  recentMessages?: import("../types/messages.js").ChatMessage[];
  /** Active goal objective (when invoked from `/goal`). */
  goalObjective?: string;
  /** Names locked-on by manual activation. They get +999 score and bypass
   *  keyword scoring; planner still resolves their requires/conflicts. */
  manualNames?: readonly string[];
  /** Token cap (= `ContextBudget.skills`). The planner culls lowest-score
   *  nodes until this fits. Set to 0 to drop everything (defensive). */
  budgetTokens: number;
}

export interface PlanOutput {
  /** Final activated nodes in score-DESC order. Caller renders their
   *  `systemFragment` into the prompt. */
  nodes: SkillNode[];
  /** Names of skills dropped to fit `budgetTokens`. */
  droppedByBudget: string[];
  /** Names of skills lost to same-conflict-group resolution. */
  droppedByConflict: string[];
  /** `requires` referenced but not in registry (skill skipped or fail). */
  missingRequired: string[];
  /** Σ budgetTokens of `nodes`. */
  totalTokens: number;
  /** Stable hash of (intent + selected names) — caller compares to
   *  skills.lock to skip replanning when intent is unchanged. */
  fingerprint: string;
}

/**
 * Run the planner against a registry snapshot.
 *
 * Pure, sync, deterministic for the same inputs. Empty registry → empty
 * plan with zero-tokens (fingerprint reflects empty selection).
 */
export function plan(
  registrySnapshot: readonly Skill[],
  input: PlanInput,
): PlanOutput {
  if (registrySnapshot.length === 0) {
    return emptyPlan(input);
  }

  const intent = extractIntent({
    latestUserText: input.latestUserText,
    recentMessages: input.recentMessages,
    goalObjective: input.goalObjective,
  });
  const manualSet = new Set(input.manualNames ?? []);

  // ── 1. Score every skill ─────────────────────────────────────────────────
  const seeds: SkillNode[] = [];
  for (const skill of registrySnapshot) {
    const score = scoreSkill(skill, intent, manualSet);
    if (score > 0) {
      seeds.push({ skill, score });
    }
  }

  if (seeds.length === 0) {
    return emptyPlan(input);
  }

  // ── 2. Closure (BFS over `requires`) ─────────────────────────────────────
  const registryMap = new Map(registrySnapshot.map((s) => [s.name, s]));
  const closure = computeClosure(seeds, registryMap);

  // Skip skills that need missing required deps. Manual-locked names with
  // missing deps are kept (caller's responsibility — SkillTool handles the
  // hard-fail path; planner is best-effort).
  const droppedByMissingDeps = new Set<string>();
  if (closure.missingRequired.length > 0) {
    // Walk seeds: any seed whose transitive `requires` includes a missing
    // name → drop it (unless manually locked).
    for (const seed of seeds) {
      if (manualSet.has(seed.skill.name)) continue;
      if (skillNeedsMissing(seed.skill, registryMap, closure.missingRequired)) {
        droppedByMissingDeps.add(seed.skill.name);
      }
    }
  }
  const surviving = closure.nodes.filter(
    (n) => !droppedByMissingDeps.has(n.skill.name),
  );

  // ── 3. Conflict resolution ───────────────────────────────────────────────
  const conflictRes = resolveConflicts(surviving);
  // Manual-locked names should never be dropped by conflict resolution —
  // promote them above any peer; if a conflict still exists, drop the peer.
  const conflictDropped = conflictRes.dropped
    .filter((d) => !manualSet.has(d.name))
    .map((d) => d.name);

  // ── 4. Budget enforce ────────────────────────────────────────────────────
  const budgetRes = enforceBudget(conflictRes.kept, input.budgetTokens);
  // Manual locks override budget too — but we still warn caller via the
  // dropped list. Planner returns the budget result as-is; caller (`runSkillRound`)
  // will refuse to drop manual entries by re-injecting them post-budget.
  const budgetDropped = budgetRes.dropped;

  const fingerprint = computeFingerprint(input, intent, budgetRes.kept);

  return {
    nodes: budgetRes.kept,
    droppedByBudget: budgetDropped,
    droppedByConflict: conflictDropped,
    missingRequired: closure.missingRequired,
    totalTokens: budgetRes.totalTokens,
    fingerprint,
  };
}

function emptyPlan(input: PlanInput): PlanOutput {
  return {
    nodes: [],
    droppedByBudget: [],
    droppedByConflict: [],
    missingRequired: [],
    totalTokens: 0,
    fingerprint: computeFingerprint(input, null, []),
  };
}

/**
 * Score a single skill against extracted intent.
 *
 * Returns 0 when the skill should not be considered (no keyword hits AND
 * no manual lock AND `when !== 'always'`).
 */
function scoreSkill(
  skill: Skill,
  intent: IntentResult,
  manualSet: Set<string>,
): number {
  let score = 0;

  // Manual lock: +999 (sticky, dwarfs any organic score).
  if (manualSet.has(skill.name)) {
    score += 999;
  }

  // 'always' trigger: +500 (below manual but above any organic). Use for
  // system-wide skills (e.g. a hypothetical 'safety-net' skill).
  const when = skill.triggers.when ?? "on-request";
  if (when === "always") {
    score += 500;
  }

  // Keyword matches: +1 each (case-insensitive substring on the lowercased
  // tag list, which already includes verb-stem normalization).
  if (skill.triggers.keywords && skill.triggers.keywords.length > 0) {
    const lcKeywords = skill.triggers.keywords.map((k) => k.toLowerCase());
    for (const tag of intent.tags) {
      for (const kw of lcKeywords) {
        if (tag === kw || tag.includes(kw)) {
          score += 1;
        }
      }
    }
  }

  // Regex patterns: +1 each (run against latest text via tags concat).
  if (skill.triggers.patterns && skill.triggers.patterns.length > 0) {
    const haystack = intent.tags.join(" ");
    for (const re of skill.triggers.patterns) {
      // Reset lastIndex so /g regexes are deterministic (AGENTS.md §16).
      re.lastIndex = 0;
      if (re.test(haystack)) score += 1;
    }
  }

  // pre-tool boost: +0.5 if a recent tool call hinted at workflow.
  if (when === "pre-tool" && intent.hasRecentToolHint) {
    score += 0.5;
  }

  // provides × goal overlap: +0.5 each.
  if (skill.provides && intent.goalTokens.length > 0) {
    const goalSet = new Set(intent.goalTokens.map((t) => t.toLowerCase()));
    for (const cap of skill.provides) {
      const lc = cap.toLowerCase();
      if (goalSet.has(lc)) score += 0.5;
      // Also match capability fragments to goal tokens (e.g.
      // 'conventional-commits' overlaps with 'commit' in the goal).
      for (const piece of lc.split(/[-_]/)) {
        if (piece.length >= 4 && goalSet.has(piece)) score += 0.5;
      }
    }
  }

  return score;
}

/** True iff `skill` (or any transitive `requires`) hits a missing dep name. */
function skillNeedsMissing(
  skill: Skill,
  registry: Map<string, Skill>,
  missing: readonly string[],
): boolean {
  const missingSet = new Set(missing);
  const visited = new Set<string>();
  const queue: string[] = [skill.name];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const s = registry.get(next);
    if (!s) {
      if (missingSet.has(next)) return true;
      continue;
    }
    for (const req of s.requires ?? []) {
      if (missingSet.has(req)) return true;
      if (!registry.has(req)) {
        // Unknown but not in `missing` — ignore (planner treats unknown deps
        // as "best-effort skip" so a stale missing list never goes stale).
        continue;
      }
      queue.push(req);
    }
  }
  return false;
}

/**
 * Stable 12-char hex hash of the planner's PRIMARY INPUTS (latest user text
 * + goal + sorted manual names + budget cap + recent-tool hint flag). Used
 * as a cache key by `runSkillRound` to skip replanning when intent hasn't
 * changed across rounds.
 *
 * Inputs only — outputs are deterministic for the same inputs, so including
 * `selectedNames` would be tautological. The lock stores `lastSelected`
 * alongside this hash so the caller can reuse the selection list when
 * the hash matches.
 *
 * `intent` (optional) lets callers stir in extracted tags — useful when
 * a tool-call hint flips intent without the user text changing. Pass
 * `null` to skip tag-influence (planner-internal use; production callers
 * always pass a real intent).
 */
export function computeFingerprint(
  input: PlanInput,
  intent: IntentResult | null,
  /** UNUSED — kept in the signature for backward compat with early callers
   *  who passed `selected nodes`. Selected names are NOT part of the key
   *  (would defeat the cache purpose). */
  _selectedNodes?: readonly SkillNode[],
): string {
  const parts = [
    (input.latestUserText ?? "").slice(0, 4096),
    input.goalObjective ?? "",
    [...(input.manualNames ?? [])].sort().join(","),
    String(Math.max(0, Math.floor(input.budgetTokens))),
    intent ? `tools:${intent.hasRecentToolHint ? "1" : "0"}` : "",
    intent ? intent.tags.slice(0, 64).join(",") : "",
  ];
  const h = createHash("sha1");
  h.update(parts.join("\u0001"));
  return h.digest("hex").slice(0, 12);
}
