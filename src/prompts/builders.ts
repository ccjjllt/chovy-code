/**
 * 5-layer system prompt builder (step-15).
 *
 * Layers (priority high → low; only the *winning* layer's text is emitted):
 *   0  override       — full replacement (loop coordinator / harness)
 *   1  coordinator    — multi-agent coordinator additions
 *   2  agent          — sub-agent role-specific prompt
 *   3  custom         — user-supplied via `--system-prompt`
 *   4  default        — chovy default + optional Append
 *
 * The merge isn't a simple "highest wins" — layers 1–4 stack additively
 * (coordinator wraps agent wraps custom wraps default). Layer 0 short-
 * circuits everything else (per cc-haha's `buildEffectiveSystemPrompt`).
 *
 * Output:
 *   - `text`:        the final string sent to the provider
 *   - `staticHash`:  FNV-1a over text *before* the dynamic boundary
 *   - `dynamicHash`: FNV-1a over text *after* the boundary
 *   - `segments`:    per-section accounting for telemetry / debugging
 *
 * Why one builder per request rather than two cached halves:
 *   - The static prefix is provider-stable but mode-aware (plan note rides
 *     in static so caching still applies). Re-hashing on every request
 *     keeps the API tiny and cheap (≤ 4 KB of static usually).
 */

import type { AgentRole } from "../types/agent.js";
import { boundaryGlue, defaultStaticPrompt } from "./default.js";
import { CHOVY_PROMPT_DYNAMIC_BOUNDARY, splitAtBoundary } from "./boundary.js";
import {
  contextBudgetSection,
  cwdSection,
  joinSections,
  memorySection,
  modelSection,
  notesSection,
  pressureSection,
  skillFragmentsSection,
  skillsSection,
  type ContextBudgetSnippet,
  type CwdSnippet,
  type PressureSnippet,
  type SkillFragmentsSnippet,
} from "./snippets.js";
import { _fnv1aForTesting as fnv1a } from "./fingerprint.js";

export type SystemPromptLayer =
  | "override"
  | "coordinator"
  | "agent"
  | "custom"
  | "default";

export interface AgentPromptInput {
  role: AgentRole;
  prompt: string;
  /** When true, omit the memory dynamic section entirely (least-context). */
  omitMemory?: boolean;
}

export interface SystemContext {
  cwd: CwdSnippet;
  model: { provider: string; model: string; knowledgeCutoff?: string; contextWindow?: number };
  /** Pre-rendered MEMORY/checkpoint summary (step-25 will fill this). */
  memoryText?: string;
  notesText?: string;
  loadedSkills?: string[];
  /** CSG active-skill fragments (step-29). The engine fills this from
   *  `ToolSession.activeSkillFragments` via `runSkillRound`; the prompt
   *  builder renders each as a `<skill name="...">` block in the dynamic
   *  suffix. Undefined or empty ⇒ no `## Active skills` section. */
  skillFragments?: SkillFragmentsSnippet;
  contextBudget?: ContextBudgetSnippet;
  /** SCW pressure block (step-27). Renders nothing when omitted or
   *  `level === 'fresh'`; the engine fills it after monitor.inspect()
   *  flips the level. */
  pressure?: PressureSnippet;
  /** Permission mode — used to inject the plan-mode note into static. */
  planMode?: boolean;
}

export interface BuildOptions {
  override?: string;
  coordinator?: string;
  agent?: AgentPromptInput;
  custom?: string;
  defaultAppend?: string;
  context: SystemContext;
}

export interface PromptSegment {
  name: string;
  bytes: number;
  from: SystemPromptLayer;
}

export interface EffectivePrompt {
  text: string;
  staticHash: number;
  dynamicHash: number;
  segments: PromptSegment[];
}

/**
 * Build the final system prompt.
 *
 * Override semantics: when `opts.override` is set, the returned text is
 * exactly that string (no boundary glue, no dynamic suffix). The hashes
 * still split at the boundary marker if the override happens to embed
 * one; otherwise `dynamicHash` is the empty-string hash.
 */
export function buildEffectiveSystemPrompt(opts: BuildOptions): EffectivePrompt {
  // ── Layer 0: override short-circuit ───────────────────────────────────────
  if (opts.override) {
    return finalize([{ name: "override", text: opts.override, from: "override" }]);
  }

  const segments: Array<{ name: string; text: string; from: SystemPromptLayer }> = [];

  // ── Layer 1: coordinator (prepended; rare) ────────────────────────────────
  if (opts.coordinator) {
    segments.push({ name: "coordinator", text: opts.coordinator, from: "coordinator" });
  }

  // ── Layer 2: sub-agent role prompt (prepended after coordinator) ──────────
  if (opts.agent) {
    segments.push({
      name: `agent:${opts.agent.role}`,
      text: opts.agent.prompt,
      from: "agent",
    });
  }

  // ── Layer 3: user --system-prompt override prefix ─────────────────────────
  if (opts.custom) {
    segments.push({ name: "custom", text: opts.custom, from: "custom" });
  }

  // ── Layer 4: chovy default (always present unless layer 0 wins) ───────────
  segments.push({
    name: "default",
    text: defaultStaticPrompt({ planMode: opts.context.planMode }),
    from: "default",
  });
  if (opts.defaultAppend) {
    segments.push({
      name: "default-append",
      text: opts.defaultAppend,
      from: "default",
    });
  }

  // ── Boundary marker — everything after this is dynamic ────────────────────
  segments.push({
    name: "boundary",
    text: boundaryGlue(),
    from: "default",
  });

  // ── Dynamic sections (cwd / model / memory / skills / budget) ─────────────
  const omitMemory = opts.agent?.omitMemory === true;

  const dynamicText = joinSections([
    cwdSection(opts.context.cwd),
    modelSection(opts.context.model),
    omitMemory ? "" : memorySection(opts.context.memoryText),
    omitMemory ? "" : notesSection(opts.context.notesText),
    skillsSection(opts.context.loadedSkills),
    skillFragmentsSection(opts.context.skillFragments),
    contextBudgetSection(opts.context.contextBudget),
    pressureSection(opts.context.pressure),
  ]);
  if (dynamicText) {
    segments.push({ name: "dynamic", text: dynamicText, from: "default" });
  }

  return finalize(segments);
}

function finalize(
  segments: Array<{ name: string; text: string; from: SystemPromptLayer }>,
): EffectivePrompt {
  const text = segments.map((s) => s.text).join("\n\n").trim() + "\n";
  const split = splitAtBoundary(text);
  const accounting: PromptSegment[] = segments.map((s) => ({
    name: s.name,
    bytes: s.text.length,
    from: s.from,
  }));
  return {
    text,
    staticHash: fnv1a(split.static),
    dynamicHash: fnv1a(split.dynamic),
    segments: accounting,
  };
}

/**
 * Surface the boundary marker so callers writing custom `override` strings
 * can include it without re-importing from `boundary.ts`.
 */
export const PROMPT_DYNAMIC_BOUNDARY = CHOVY_PROMPT_DYNAMIC_BOUNDARY;
