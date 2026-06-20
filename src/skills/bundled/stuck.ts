import type { Skill } from "../../types/skill.js";

export const stuckSkill: Skill = {
  name: "stuck",
  summary: "stuck",
  triggers: {
    keywords: ["stuck"],
    when: "on-request"
  },
  budgetTokens: 350,
  requires: [],
  provides: ["strategy-reset"],
  conflicts: ["loop"],
  systemFragment: "stuck"
};
