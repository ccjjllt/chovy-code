/**
 * CSG glue between QueryEngine and `src/skills/` (step-29).
 *
 * One helper — `runSkillRound` — extracted from `queryEngine.ts:run()` per
 * AGENTS.md §17 600-line cap. Mirrors `engine/contextHook.ts` (step-27) and
 * `engine/rebuildHook.ts` (step-28) shape:
 *
 *   - QueryEngine owns the *when* (each round, after SCW glue) and *how it
 *     wires through* (forwarded to `fillBuildOptions` for the next prompt).
 *   - This module owns the *how* (registry init + planner + manual merge +
 *     lock IO + telemetry).
 *
 * No state lives here — the planner is pure; manual entries live on
 * `ToolSession.activeSkillFragments`. The skills.lock fingerprint is the
 * only thing read across rounds, and only via `loadSkillsLock` /
 * `persistSkillsLock` (atomic, in `~/.chovy/projects/<id>/skills.lock`).
 *
 * Single-source: this module is the ONLY emitter of `skill.plan`
 * telemetry (mirrors §22 `context.threshold` / §23 `context.rebuild`).
 *
 * Auto vs manual:
 *   - Auto planner runs only when `CHOVY_SKILLS_AUTO=1` OR
 *     `feature('skills.auto')` is enabled (default OFF — least-surprise,
 *     AGENTS.md §17 `feature('auto.classifier')` precedent).
 *   - Manual activations (SkillTool / `/skill <name>`) work regardless;
 *     they live on `session.activeSkillFragments` and `session.manualSkillNames`
 *     across rounds.
 */

import { logger } from "../logger/index.js";
import { feature } from "../config/features.js";
import { emitTelemetry } from "../telemetry/index.js";
import {
  ensureBundledSkillsInitialized,
  extractIntent,
  listSkills,
  loadSkillsLock,
  persistSkillsLock,
  plan,
  computeFingerprint,
  type PlanOutput,
} from "../skills/index.js";
import { computeBudget } from "../context/budgets.js";
import type { ChatMessage } from "../types/messages.js";
import type { Skill } from "../types/skill.js";
import type { ToolSession } from "../types/tool.js";
import type { ChovyConfig } from "../config/config.js";
import type { ProviderId } from "../types/provider.js";
import type { AgentRole } from "../types/agent.js";
import type { SkillFragmentsSnippet } from "../prompts/index.js";

export interface SkillRoundInput {
  /** Live message tail. The planner reads `latestUserText` from the most
   *  recent user message + intent hints from the last ~6 messages. */
  messages: ChatMessage[];
  /** Per-run session state. The planner mutates
   *  `session.activeSkillFragments` (auto path) and reads
   *  `session.manualSkillNames` (manual carry-over). */
  session: ToolSession;
  /** Goal objective when invoked from `/goal`. Boosts skills whose
   *  `provides` overlap goal tokens. */
  goalObjective?: string;
  /** Caller's agent role (top-level `main` only — sub-agents skip the
   *  planner to avoid cascading skill loads inside delegated work). */
  agentRole: AgentRole;
  /** Provider id + model — passed through to `computeBudget` to size the
   *  `skills` slab against the model's context window. */
  provider: ProviderId;
  model: string;
  /** Live ChovyConfig — used by `computeBudget` for slab overrides. */
  cfg: ChovyConfig;
  /** cwd used for `skills.lock` IO. */
  cwd: string;
  /** Process env (split for testability). Default is `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface SkillRoundOutcome {
  /** Names list for the `## Loaded skills` ToC line. Includes both
   *  auto-selected and manual entries. */
  loadedSkills: string[];
  /** Body blocks for the `## Active skills` section. Caller forwards to
   *  `fillBuildOptions(...)`. Undefined when no skills active. */
  skillFragments?: SkillFragmentsSnippet;
}

/**
 * Run a single CSG planner round.
 *
 * Sub-agents skip planner entirely — the parent's planning context is
 * what matters; sub-agents just consume a fixed prompt. Manual activations
 * still propagate via `session` (the parent's session is shared via
 * snapshot for sub-agent runs that opt in; default is no share).
 */
export async function runSkillRound(
  input: SkillRoundInput,
): Promise<SkillRoundOutcome> {
  const t0 = Date.now();
  const env = input.env ?? process.env;

  // Sub-agents don't plan — the parent prompt was already constructed
  // with the right skills. They still see manual fragments injected by
  // the parent (when shareSession=true), but never invoke the planner
  // themselves.
  if (input.agentRole !== "main") {
    return buildOutcomeFromSession(input.session);
  }

  // Ensure bundled skills are registered. Idempotent + fast.
  try {
    await ensureBundledSkillsInitialized();
  } catch (err) {
    logger.warn("runSkillRound: ensureBundledSkillsInitialized failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Continue — we may still have manual entries on the session.
  }

  const registrySnapshot: readonly Skill[] = listSkills();
  const autoEnabled = isAutoEnabled(env);
  const budget = computeBudget(input.model, input.provider, input.cfg, env);

  // Manual-only or registry-empty path: keep session entries, emit telemetry, return.
  if (!autoEnabled || registrySnapshot.length === 0) {
    const outcome = buildOutcomeFromSession(input.session);
    emitTelemetry({
      type: "skill.plan",
      mode: registrySnapshot.length === 0 ? "disabled" : "manual-only",
      selected: outcome.loadedSkills,
      droppedByBudget: 0,
      droppedByConflict: 0,
      missingRequired: 0,
      totalTokens: sumTokensByName(outcome.loadedSkills, registrySnapshot),
      budgetTokens: budget.skills,
      fingerprintHit: false,
      durMs: Date.now() - t0,
    });
    return outcome;
  }

  // ── Auto planner path ────────────────────────────────────────────────────
  const latestUserText = pickLatestUserText(input.messages);
  const manualNames = input.session.manualSkillNames ?? [];
  const recentMessages = input.messages.slice(-8);

  const planInput = {
    latestUserText,
    goalObjective: input.goalObjective,
    manualNames,
    budgetTokens: budget.skills,
    recentMessages,
  };

  // Lock check: compute the input-only fingerprint and compare to the
  // stored lock. Match → reuse `lastSelected` without replanning. Tag
  // influence is folded into the fingerprint via `extractIntent` so a
  // tool-hint flip (e.g. fresh git diff) invalidates the cache.
  const lock = await loadSkillsLock(input.cwd);
  const intentForKey = (() => {
    // Cheap intent extraction just for fingerprint computation. Runs
    // synchronously and is the same call the planner would make.
    return extractIntent({
      latestUserText,
      recentMessages,
      goalObjective: input.goalObjective,
    });
  })();
  const cacheKey = computeFingerprint(planInput, intentForKey);

  let result: PlanOutput;
  let fingerprintHit = false;
  if (lock && lock.fingerprint === cacheKey) {
    // Reuse lock — rebuild the node list from the registry. If a stored
    // skill name no longer registers (renamed / removed), drop it
    // silently (the cache will be rebuilt on the next miss anyway).
    const reusedSkills = lock.lastSelected
      .map((name) => registrySnapshot.find((s) => s.name === name))
      .filter((s): s is Skill => Boolean(s));
    result = {
      nodes: reusedSkills.map((s) => ({ skill: s, score: 0 })),
      droppedByBudget: [],
      droppedByConflict: [],
      missingRequired: [],
      totalTokens: reusedSkills.reduce(
        (acc, s) => acc + Math.max(0, s.budgetTokens),
        0,
      ),
      fingerprint: cacheKey,
    };
    fingerprintHit = true;
  } else {
    result = plan(registrySnapshot, planInput);
  }

  // ── Merge planner output into session.activeSkillFragments ───────────────
  // 1. Start with manual entries (sticky across rounds).
  // 2. Layer auto-selected entries on top (replaces stale auto entries).
  const manualSet = new Set(manualNames);
  const next: Record<string, string> = {};
  // Carry over manual entries first.
  if (input.session.activeSkillFragments) {
    for (const [name, body] of Object.entries(input.session.activeSkillFragments)) {
      if (manualSet.has(name)) next[name] = body;
    }
  }
  // Auto entries (from planner output).
  for (const node of result.nodes) {
    if (manualSet.has(node.skill.name)) continue; // manual already carried
    next[node.skill.name] = node.skill.systemFragment;
  }
  input.session.activeSkillFragments = next;

  // ── Persist lock (best-effort) ───────────────────────────────────────────
  if (!fingerprintHit) {
    await persistSkillsLock(input.cwd, {
      lastSelected: result.nodes.map((n) => n.skill.name),
      ts: Date.now(),
      fingerprint: result.fingerprint,
      version: 1,
    });
  }

  // ── Telemetry (single source) ────────────────────────────────────────────
  emitTelemetry({
    type: "skill.plan",
    mode: "auto",
    selected: Object.keys(next),
    droppedByBudget: result.droppedByBudget.length,
    droppedByConflict: result.droppedByConflict.length,
    missingRequired: result.missingRequired.length,
    totalTokens: result.totalTokens,
    budgetTokens: budget.skills,
    fingerprintHit,
    durMs: Date.now() - t0,
  });

  return buildOutcomeFromSession(input.session);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isAutoEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env["CHOVY_SKILLS_AUTO"] === "1") return true;
  if (env["CHOVY_SKILLS_AUTO"] === "0") return false;
  return feature("skills.auto");
}

function pickLatestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && m.content) return m.content;
  }
  return "";
}

function buildOutcomeFromSession(session: ToolSession): SkillRoundOutcome {
  const active = session.activeSkillFragments;
  if (!active) return { loadedSkills: [] };
  const entries = Object.entries(active).filter(
    ([name, body]) =>
      typeof name === "string" &&
      name.length > 0 &&
      typeof body === "string" &&
      body.length > 0,
  );
  if (entries.length === 0) return { loadedSkills: [] };
  return {
    loadedSkills: entries.map(([name]) => name),
    skillFragments: {
      fragments: entries.map(([name, body]) => ({ name, body })),
    },
  };
}

function sumTokensByName(
  names: readonly string[],
  registry: readonly Skill[],
): number {
  if (names.length === 0) return 0;
  const map = new Map(registry.map((s) => [s.name, s]));
  let total = 0;
  for (const n of names) {
    const s = map.get(n);
    if (s) total += Math.max(0, s.budgetTokens);
  }
  return total;
}
