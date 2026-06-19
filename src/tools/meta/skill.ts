/**
 * `skill` — invoke a skill by name (step-29 — CSG real implementation).
 *
 * Frozen schema (from step-11): `{ skill: string, args?: string }`. Step-29
 * swaps the `run` body to do real work — schema, name, version, family,
 * `fullTriggers`, `userFacingName`, and registration in
 * `src/tools/index.ts:46` are unchanged.
 *
 * Behavior (matches `docs/step-29-skill-graph.md` §"SkillTool"):
 *
 *   1. Look up the requested skill name in the registry.
 *   2. Resolve the manual closure (skill + transitive `requires`) via
 *      `resolveManualClosure`. Missing required deps → hard fail
 *      (`TOOL_DENIED`). Conflicts with already-active skills → hard fail.
 *   3. Merge the closure into `ctx.session.activeSkillFragments` and the
 *      target's name into `ctx.session.manualSkillNames` (sticky across
 *      rounds; planner preserves manual entries).
 *   4. Inject `args` into the rendered fragment when supplied (appends
 *      a `### Additional args` section so the skill body sees user input).
 *
 * AGENTS.md alignment:
 *   - §16 ToolContext frozen — only the ToolSession optional fields
 *     `activeSkillFragments` / `manualSkillNames` are set; ctx itself is
 *     not mutated outside that bag.
 *   - §17 single-source — `skill.plan` telemetry is NOT emitted here
 *     (only `engine/skillHook.ts:runSkillRound` fires it). The tool
 *     records its work via `tool.call` like any other tool.
 *   - §18 step-19 — `subagent_type` enum stays in `agent.ts`; this tool
 *     keeps `skill: z.string()` free-form so user-installed skills work.
 */

import { z } from "zod";

import {
  ensureBundledSkillsInitialized,
  getSkill,
  resolveManualClosure,
  listSkills,
} from "../../skills/index.js";
import type {
  PermissionPreflight,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types/index.js";

const argsSchema = z.object({
  skill: z
    .string()
    .min(1)
    .describe("The skill name to invoke (e.g. \"commit\", \"review\")."),
  args: z
    .string()
    .optional()
    .describe("Free-form args string forwarded to the skill body."),
});

type Args = z.infer<typeof argsSchema>;

export const skillTool: Tool<typeof argsSchema> = {
  name: "skill",
  version: 2,
  family: "meta",
  isReadOnly: false,
  canUseWithoutAsk: true, // activation is harmless; skill bodies still gate via their own tools

  desc: {
    lean:
      "Activate a named skill (CSG). Adds the skill's systemFragment + transitive requires to this turn's prompt.",
    full:
      "Activate a named skill — a reusable workflow systemFragment that is " +
      "rendered into the system prompt as a `<skill name=\"...\">` block " +
      "for this and future rounds (until cleared).\n\n" +
      "- `skill` is the skill name (e.g. `commit`, `review`, `refactor`, " +
      "`format`, `test`, `pr`, `ts-fix`, or any user-installed skill).\n" +
      "- `args` is a free-form string the skill body interprets (appended " +
      "to the fragment as `### Additional args`).\n\n" +
      "The CSG planner resolves the skill's transitive `requires` (e.g. " +
      "activating `commit` while `format` is required pulls `format` in) " +
      "and refuses the call when:\n" +
      "  • a required dependency is not registered (`TOOL_DENIED`);\n" +
      "  • the skill conflicts with an already-active skill (`TOOL_DENIED`).\n\n" +
      "Manual activations are sticky: once activated, the skill stays in " +
      "`session.manualSkillNames` across rounds. Use `/skill clear` (slash) " +
      "to reset.",
    examples: [
      `skill({ skill: "commit" })`,
      `skill({ skill: "review", args: "focus on src/skills/ changes" })`,
      `skill({ skill: "ts-fix" })  // pulls in 'format' via requires`,
    ],
  },

  fullTriggers: [
    /\b(skills?|invoke\s+skill|run\s+skill|activate\s+skill)\b/i,
    /(技能|调用技能|运行技能|激活技能)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    return args?.skill ? `Skill: ${args.skill}` : "Skill";
  },

  checkPermissions(): PermissionPreflight {
    // Pure activation — no fs / network / process side effects. The skill
    // BODY may mention tools that themselves require permission; those
    // gate independently when the agent calls them.
    return { outcome: "allow" };
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    // Make sure bundled skills are loaded before we look up.
    try {
      await ensureBundledSkillsInitialized();
    } catch {
      /* fall through to lookup; `getSkill` returns undefined → unknown skill */
    }

    const target = getSkill(args.skill);
    if (!target) {
      const known = listSkills().map((s) => s.name).sort().join(", ");
      return {
        ok: false,
        content: `unknown skill: ${args.skill}. Known: ${known || "(none)"}`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }

    // Build the registry map for closure resolution. Cheap (≤ a few dozen
    // bundled skills); skipping a top-level cache keeps the tool stateless.
    const registryMap = new Map(listSkills().map((s) => [s.name, s]));

    // What's already active in this session? Manual + auto fragments both
    // count for conflict detection (a manual activation should not stomp
    // on an auto-loaded sibling either).
    const session = ctx?.session;
    const existingActive = new Set(
      Object.keys(session?.activeSkillFragments ?? {}),
    );

    const closure = resolveManualClosure(target, registryMap, existingActive);

    if (closure.missingRequired.length > 0) {
      return {
        ok: false,
        content:
          `${args.skill} needs the following missing skill(s): ` +
          `${closure.missingRequired.join(", ")}. ` +
          `Install / register them before activating.`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }

    if (closure.conflictsWithActive.length > 0) {
      return {
        ok: false,
        content:
          `${args.skill} conflicts with already-active skill(s): ` +
          `${closure.conflictsWithActive.join(", ")}. ` +
          `Deactivate the conflicting skill first (use \`/skill clear\` to reset all).`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }

    // Inject into session. Build the bag if missing (the engine seeds it,
    // but tests / sub-agents may run with a bare ToolContext).
    if (!ctx?.session) {
      // No session bag → we cannot persist activation across rounds. Tell
      // the caller; useful diagnostic when running the tool standalone.
      return {
        ok: false,
        content:
          "skillTool: ctx.session not provided — cannot persist activation. " +
          "This usually means the tool was invoked outside the QueryEngine; " +
          "the engine seeds session for every run.",
        errorCode: "INTERNAL",
        meta: { durMs: Date.now() - t0 },
      };
    }

    ctx.session.activeSkillFragments ??= {};
    ctx.session.manualSkillNames ??= [];

    const argsSuffix = args.args && args.args.trim().length > 0
      ? `\n\n### Additional args\n${args.args.trim()}`
      : "";

    const activatedNames: string[] = [];
    for (const node of closure.nodes) {
      const body = node.skill.systemFragment + argsSuffix;
      ctx.session.activeSkillFragments[node.skill.name] = body;
      activatedNames.push(node.skill.name);
    }

    // Mark only the EXPLICITLY-asked skill as manual (transitively-required
    // ones stay auto so the planner can manage them). Avoids accidentally
    // pinning every dependency just because the user activated a leaf.
    if (!ctx.session.manualSkillNames.includes(target.name)) {
      ctx.session.manualSkillNames.push(target.name);
    }

    const chain =
      activatedNames.length === 1
        ? `'${target.name}'`
        : `'${target.name}' (chain: ${activatedNames.join(", ")})`;

    return {
      ok: true,
      content: `Skill ${chain} activated for this and future rounds. ` +
        `The skill's systemFragment is now in the prompt under ` +
        `<skill name="${target.name}">.`,
      structuredOutput: {
        kind: "activated",
        target: target.name,
        activated: activatedNames,
        manualSkillNames: [...ctx.session.manualSkillNames],
      },
      meta: { durMs: Date.now() - t0 },
    };
  },
};
