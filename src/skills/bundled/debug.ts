import type { Skill } from "../../types/skill.js";

export const debugSkill: Skill = {
  name: "debug",
  summary: "debug",
  triggers: {
    keywords: ["debug"],
    when: "on-request"
  },
  budgetTokens: 650,
  requires: ["verify"],
  provides: ["bug-isolation"],
  conflicts: [],
  systemFragment: "debug"
};
