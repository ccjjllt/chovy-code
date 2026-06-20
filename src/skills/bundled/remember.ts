import type { Skill } from "../../types/skill.js";

export const rememberSkill: Skill = {
  name: "remember",
  summary: "remember",
  triggers: {
    keywords: ["remember"],
    when: "on-request"
  },
  budgetTokens: 250,
  requires: [],
  provides: ["durable-memory"],
  conflicts: [],
  systemFragment: "remember"
};
