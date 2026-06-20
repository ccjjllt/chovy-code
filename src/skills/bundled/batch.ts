import type { Skill } from "../../types/skill.js";

export const batchSkill: Skill = {
  name: "batch",
  summary: "batch",
  triggers: {
    keywords: ["batch"],
    when: "on-request"
  },
  budgetTokens: 450,
  requires: [],
  provides: ["parallel-work-plan"],
  conflicts: [],
  systemFragment: "batch"
};
