import type { Skill } from "../../types/skill.js";

export const skillifySkill: Skill = {
  name: "skillify",
  summary: "skillify",
  triggers: {
    keywords: ["skillify"],
    when: "on-request"
  },
  budgetTokens: 500,
  requires: [],
  provides: ["skill-authoring"],
  conflicts: [],
  systemFragment: "skillify"
};
