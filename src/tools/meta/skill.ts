/**
 * `skill` — invoke a skill by id (step-11 stub).
 *
 * Per `docs/step-11-meta-tools.md §Skill(stub)`:
 *   - The real skill runtime lands in step-29 (CSG — Conditional Skill
 *     Graph). Until then this tool refuses with `INTERNAL` and a pointer to
 *     step-29 so the model learns the feature isn't wired yet instead of
 *     hallucinating success.
 *   - The schema matches the eventual shape (`skill` id + optional `args`)
 *     so step-29 only needs to swap the `run` body, not the contract.
 *
 * Why a stub at all? The tool must exist in the registry NOW so:
 *   - ATP (step-07) can score it and surface its description to the model,
 *     teaching it that skills exist (even if currently refused).
 *   - Step-29's real implementation replaces only `run`, with no churn in
 *     the schema, registration, or ATP plumbing.
 *   - The `chovy skill list` CLI command (also a stub) has a matching tool
 *     the agent can call.
 */

import { z } from "zod";

import type {
  PermissionPreflight,
  Tool,
  ToolResult,
} from "../../types/index.js";

const argsSchema = z.object({
  skill: z
    .string()
    .min(1)
    .describe("The skill id to invoke (e.g. \"commit\", \"simplify\")."),
  args: z
    .string()
    .optional()
    .describe("Free-form args string forwarded to the skill body."),
});

type Args = z.infer<typeof argsSchema>;

const NOT_READY_MSG =
  "SkillTool stub: the skill runtime is implemented in step-29 (CSG). " +
  "Until then `skill` cannot execute a skill body. Mention the skill id " +
  "in your reply so the user can run it manually once step-29 lands.";

export const skillTool: Tool<typeof argsSchema> = {
  name: "skill",
  version: 2,
  family: "meta",
  isReadOnly: false, // a real skill can mutate the world; treat as non-readonly
  canUseWithoutAsk: false, // skill bodies may do anything → ask first once live

  desc: {
    lean:
      "Invoke a named skill (multi-step workflow). STUB — real runtime lands " +
      "in step-29 (CSG); refuses with INTERNAL until then.",
    full:
      "Invoke a named skill — a reusable multi-step workflow authored as a " +
      "system-prompt fragment (see `docs/step-29-*.md`, CSG).\n\n" +
      "- `skill` is the skill id (matches `~/.chovy/skills/<id>/SKILL.md` or " +
      "a bundled skill).\n" +
      "- `args` is a free-form string the skill body interprets.\n" +
      "- STATUS: this tool is a STUB. It refuses with `errorCode: \"INTERNAL\"` " +
      "and a pointer to step-29 until the Conditional Skill Graph runtime " +
      "lands. The schema is final so step-29 swaps only the `run` body.\n" +
      "- Do NOT call this expecting a side effect today; surface the intent " +
      "to the user instead.",
    examples: [
      `skill({ skill: "commit" })  // → INTERNAL (step-29)`,
      `skill({ skill: "simplify", args: "src/tools/meta/" })  // → INTERNAL (step-29)`,
    ],
  },

  fullTriggers: [
    /\b(skills?|invoke\s+skill|run\s+skill)\b/i,
    /(技能|调用技能|运行技能)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    return args?.skill ? `Skill: ${args.skill}` : "Skill";
  },

  checkPermissions(): PermissionPreflight {
    // Stub never executes anything, so there's nothing to gate. The real
    // step-29 implementation will call the CSG planner's permission check.
    return { outcome: "allow" };
  },

  async run(args: Args): Promise<ToolResult> {
    const t0 = Date.now();
    return {
      ok: false,
      content: NOT_READY_MSG,
      errorCode: "INTERNAL",
      structuredOutput: {
        kind: "stub",
        step: "step-29",
        skill: args.skill,
      },
      meta: { durMs: Date.now() - t0 },
    };
  },
};
