import type { Skill } from "../../types/skill.js";

export const verifySkill: Skill = {
  name: "verify",
  summary: "verify",
  triggers: {
    keywords: ["verify"],
    when: "on-request"
  },
  budgetTokens: 350,
  requires: ["test"],
  provides: ["verification-evidence"],
  conflicts: [],
  systemFragment: "verify"
};
