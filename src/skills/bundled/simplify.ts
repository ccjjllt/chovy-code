import type { Skill } from "../../types/skill.js";

export const simplifySkill: Skill = {
  name: "simplify",
  summary: "simplify",
  triggers: {
    keywords: ["simplify"],
    when: "on-request"
  },
  budgetTokens: 300,
  requires: [],
  provides: ["complexity-reduction"],
  conflicts: [],
  systemFragment: "simplify"
};
