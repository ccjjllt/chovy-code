/**
 * Skill graph operations (step-29 — CSG).
 *
 * Pure topological helpers over the registered `Skill[]`. The planner
 * (`./planner.ts`) calls these to:
 *   1. compute the transitive `requires` closure of a seed set,
 *   2. resolve `conflicts` by keeping the highest-scored member,
 *   3. detect missing required dependencies (skill not registered).
 *
 * All functions are pure — they take a registry snapshot and a seed list and
 * return a new list. No side effects, no telemetry, no async. Easy to unit
 * test in `scripts/smoke-step29.ts`.
 *
 * Cycle detection: BFS uses a visited set so a cycle in `requires` is
 * harmless (each skill resolved once). Cycles in `provides` are nonsense
 * (capability tokens, not dependencies); we don't even look at them here.
 */

import type { Skill, SkillNode } from "../types/skill.js";

export interface ClosureResult {
  /** Final node list (seeds + transitive requires) ordered by score DESC. */
  nodes: SkillNode[];
  /** Skill names referenced by `requires` but not in the registry. */
  missingRequired: string[];
}

/**
 * Compute the `requires` closure of a seed set against the registry.
 *
 * - Seeds keep their incoming `score`.
 * - Pulled-in dependencies get a small inherited score (max(0.5, parentScore - 0.1))
 *   so they sort beneath their pullers but above ungrouped neighbors.
 * - Missing required deps are reported separately (caller decides whether
 *   to skip the dependent skill or to fail loudly).
 *
 * Idempotent: passing the same closure back returns the same closure.
 */
export function computeClosure(
  seeds: SkillNode[],
  registry: Map<string, Skill>,
): ClosureResult {
  const out = new Map<string, SkillNode>();
  const missing = new Set<string>();
  // BFS queue: [skillName, parentScore].
  const queue: Array<{ name: string; parentScore: number }> = [];

  for (const seed of seeds) {
    if (!out.has(seed.skill.name)) {
      out.set(seed.skill.name, seed);
      queue.push({ name: seed.skill.name, parentScore: seed.score });
    }
  }

  while (queue.length > 0) {
    const next = queue.shift()!;
    const skill = registry.get(next.name);
    if (!skill) continue; // seed list already validated by caller
    if (!skill.requires || skill.requires.length === 0) continue;

    for (const reqName of skill.requires) {
      const reqSkill = registry.get(reqName);
      if (!reqSkill) {
        missing.add(reqName);
        continue;
      }
      if (out.has(reqName)) continue; // already pulled in

      // Inherited score: dependencies sort just beneath their puller.
      const inheritedScore = Math.max(0.5, next.parentScore - 0.1);
      out.set(reqName, { skill: reqSkill, score: inheritedScore });
      queue.push({ name: reqName, parentScore: inheritedScore });
    }
  }

  const nodes = [...out.values()].sort((a, b) => b.score - a.score);
  return {
    nodes,
    missingRequired: [...missing].sort(),
  };
}

/**
 * Conflict resolution. Two skills conflict if either declares the other in
 * `conflicts`. We keep the one with the higher score; ties broken by name
 * (lexicographic, deterministic).
 *
 * Returns the surviving nodes plus the names dropped, so telemetry / UI can
 * show "X dropped because of conflict with Y".
 */
export function resolveConflicts(nodes: SkillNode[]): {
  kept: SkillNode[];
  dropped: Array<{ name: string; lostTo: string }>;
} {
  const byName = new Map(nodes.map((n) => [n.skill.name, n]));
  const dropped: Array<{ name: string; lostTo: string }> = [];

  // Build conflict edges (symmetric).
  const edges = new Map<string, Set<string>>();
  function addEdge(a: string, b: string): void {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  }
  for (const n of nodes) {
    for (const c of n.skill.conflicts ?? []) {
      if (byName.has(c)) {
        addEdge(n.skill.name, c);
        addEdge(c, n.skill.name);
      }
    }
  }

  // Walk nodes high→low score; for each, drop any conflicting peer of
  // lower (or tied-but-later) score that hasn't been dropped yet.
  const sorted = [...nodes].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });

  const dead = new Set<string>();
  for (const n of sorted) {
    if (dead.has(n.skill.name)) continue;
    const peers = edges.get(n.skill.name);
    if (!peers) continue;
    for (const peerName of peers) {
      if (dead.has(peerName)) continue;
      dead.add(peerName);
      dropped.push({ name: peerName, lostTo: n.skill.name });
    }
  }

  const kept = nodes.filter((n) => !dead.has(n.skill.name));
  return { kept, dropped };
}

/**
 * Budget enforcement. Drops lowest-score nodes until the cumulative
 * `budgetTokens` fits the cap. When dropping a node also drops every other
 * node that *required* it (transitive parent removal), preventing dangling
 * dependencies in the prompt.
 *
 * Returns the surviving nodes plus the names dropped. The dropped order
 * reflects the order they were considered for removal (lowest score first).
 */
export function enforceBudget(
  nodes: SkillNode[],
  capTokens: number,
): {
  kept: SkillNode[];
  dropped: string[];
  totalTokens: number;
} {
  // Build reverse-require map so dropping a leaf can cascade.
  const requiredBy = new Map<string, Set<string>>();
  const byName = new Map(nodes.map((n) => [n.skill.name, n]));
  for (const n of nodes) {
    for (const req of n.skill.requires ?? []) {
      if (!byName.has(req)) continue;
      if (!requiredBy.has(req)) requiredBy.set(req, new Set());
      requiredBy.get(req)!.add(n.skill.name);
    }
  }

  const live = new Map(nodes.map((n) => [n.skill.name, n]));
  const dropped: string[] = [];

  const tokensFor = (xs: Iterable<SkillNode>): number => {
    let t = 0;
    for (const n of xs) t += Math.max(0, n.skill.budgetTokens);
    return t;
  };

  // Cap ≤ 0 → drop everything (degenerate but defined).
  if (capTokens <= 0) {
    return {
      kept: [],
      dropped: nodes.map((n) => n.skill.name),
      totalTokens: 0,
    };
  }

  while (tokensFor(live.values()) > capTokens && live.size > 0) {
    // Pick the lowest-score live node. Ties broken by name (deterministic).
    let victim: SkillNode | undefined;
    for (const n of live.values()) {
      if (
        !victim ||
        n.score < victim.score ||
        (n.score === victim.score &&
          n.skill.name.localeCompare(victim.skill.name) > 0)
      ) {
        victim = n;
      }
    }
    if (!victim) break;
    cascadeDrop(victim.skill.name, live, requiredBy, dropped);
  }

  const kept = nodes.filter((n) => live.has(n.skill.name));
  return {
    kept,
    dropped,
    totalTokens: tokensFor(kept),
  };
}

function cascadeDrop(
  name: string,
  live: Map<string, SkillNode>,
  requiredBy: Map<string, Set<string>>,
  dropped: string[],
): void {
  if (!live.has(name)) return;
  live.delete(name);
  dropped.push(name);
  const dependents = requiredBy.get(name);
  if (!dependents) return;
  for (const dep of dependents) {
    cascadeDrop(dep, live, requiredBy, dropped);
  }
}

/**
 * Manual-mode dependency resolution (used by SkillTool). Differs from auto
 * planner closure in three ways:
 *   1. Missing required deps are FATAL (return them; caller errors out).
 *   2. Conflicts with already-active skills are FATAL (caller errors out).
 *   3. Inherited scores are not relevant (manual = sticky activation).
 *
 * Returns the closure (target + transitive `requires`) suitable for inserting
 * into `ToolSession.activeSkillFragments`.
 */
export interface ManualResolveResult {
  /** Skills to activate (target + transitive requires). */
  nodes: SkillNode[];
  /** `requires` not in registry → caller refuses. */
  missingRequired: string[];
  /** Conflicts with names in `existingActive` → caller refuses. */
  conflictsWithActive: string[];
}

export function resolveManualClosure(
  target: Skill,
  registry: Map<string, Skill>,
  existingActive: Set<string>,
): ManualResolveResult {
  const seedNodes: SkillNode[] = [{ skill: target, score: 1000 }];
  const closure = computeClosure(seedNodes, registry);

  const conflicts = new Set<string>();
  for (const n of closure.nodes) {
    for (const c of n.skill.conflicts ?? []) {
      if (existingActive.has(c)) conflicts.add(c);
    }
  }
  // Also: target's name conflicting with a peer in closure (degenerate but
  // defensive; would only happen if a dependency declares conflict with the
  // dependent, which is a registry bug).
  return {
    nodes: closure.nodes,
    missingRequired: closure.missingRequired,
    conflictsWithActive: [...conflicts].sort(),
  };
}
