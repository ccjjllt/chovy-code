import type { Skill } from "../../types/skill.js";

export const updateConfigSkill: Skill = {
  name: "update-config",
  summary: "update config",
  triggers: {
    keywords: ["update-config"],
    when: "on-request"
  },
  budgetTokens: 300,
  requires: [],
  provides: ["config-update"],
  conflicts: [],
  systemFragment: "update config"
};
