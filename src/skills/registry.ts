/**
 * Skill registry (step-29 — CSG).
 *
 * Single source of registered skills. Mirrors `src/tools/registry.ts` for
 * tool registration semantics: register-once, list-many, reset-for-tests.
 *
 * Skills are registered at module load time by `src/skills/bundled/index.ts`
 * (via `initBundledSkills()`). Future extensions (step-30): user skills
 * loaded from `~/.chovy/skills/<name>/SKILL.md` plug into the same registry.
 *
 * Concurrency / re-registration: `registerSkill` throws on duplicate `name`
 * — same defensive policy as `registerTool` so a stale module copy can't
 * silently replace a skill (which would change `systemFragment` / triggers
 * mid-run). Tests use `resetSkillRegistry` to clear between cases.
 *
 * AGENTS.md §17/§22 single-source delta: `skill.plan` telemetry is NOT
 * emitted from this module — only `src/engine/skillHook.ts:runSkillRound`
 * fires it (or `src/skills/planner.ts` if invoked standalone, but only
 * through the hook code path in production).
 */

import type { Skill } from "../types/skill.js";

const skills = new Map<string, Skill>();
let bundledInitDone = false;

/** Register a skill. Throws if `name` is already registered. */
export function registerSkill(skill: Skill): void {
  if (!skill.name || typeof skill.name !== "string") {
    throw new Error(`registerSkill: skill must have a non-empty 'name' string`);
  }
  if (skills.has(skill.name)) {
    throw new Error(
      `registerSkill: '${skill.name}' is already registered; use a unique name`,
    );
  }
  skills.set(skill.name, skill);
}

/** Lookup by name. Returns undefined if absent (caller decides response). */
export function getSkill(name: string): Skill | undefined {
  return skills.get(name);
}

/** Snapshot of all registered skills. Order = insertion order. */
export function listSkills(): Skill[] {
  return [...skills.values()];
}

/** Number of registered skills. Cheap; used by `chovy skill list` UX. */
export function skillCount(): number {
  return skills.size;
}

/** Test-only: clear the registry. */
export function resetSkillRegistry(): void {
  skills.clear();
  bundledInitDone = false;
}

/**
 * Idempotent: register the bundled skills exactly once per process. Lazy so
 * tests / CLI subcommands that don't need skills don't pay the import cost.
 *
 * The actual `initBundledSkills` lives in `./bundled/index.ts` to avoid a
 * circular dep (registry → bundled/index → registry).
 */
export async function ensureBundledSkillsInitialized(): Promise<void> {
  if (bundledInitDone) return;
  bundledInitDone = true;
  // Dynamic import keeps cyclic risk to zero — bundled modules call
  // registerSkill at top-level on first import.
  const mod = await import("./bundled/index.js");
  mod.initBundledSkills();
}

/** Synchronous variant for callers that already loaded the bundle. */
export function markBundledInitialized(): void {
  bundledInitDone = true;
}
