import { updateConfigSkill } from "./updateConfig.js";
import { batchSkill } from "./batch.js";
import { skillifySkill } from "./skillify.js";
import { rememberSkill } from "./remember.js";
import { simplifySkill } from "./simplify.js";
import { stuckSkill } from "./stuck.js";
import { debugSkill } from "./debug.js";
import { verifySkill } from "./verify.js";
/**
 * Bundled skills (step-29 — CSG).
 *
 * Idempotent registry initialization. Called once by `runSkillRound` and the
 * CLI subcommands via `registry.ensureBundledSkillsInitialized()`.
 *
 * Order of registration is the order skills appear in `chovy skill list`
 * and in `<context-rebuilt>`-style ToC outputs. We register in alphabetical
 * order so the CLI is predictable.
 */

import { registerSkill } from "../registry.js";
import { commitSkill } from "./commit.js";
import { formatSkill } from "./format.js";
import { prSkill } from "./pr.js";
import { refactorSkill } from "./refactor.js";
import { reviewSkill } from "./review.js";
import { testSkill } from "./test.js";
import { tsFixSkill } from "./tsFix.js";

export function initBundledSkills(): void {
  registerSkill(updateConfigSkill);
  registerSkill(batchSkill);
  registerSkill(skillifySkill);
  registerSkill(rememberSkill);
  registerSkill(simplifySkill);
  registerSkill(stuckSkill);
  registerSkill(debugSkill);
  registerSkill(verifySkill);
  registerSkill(commitSkill);
  registerSkill(formatSkill);
  registerSkill(prSkill);
  registerSkill(refactorSkill);
  registerSkill(reviewSkill);
  registerSkill(testSkill);
  registerSkill(tsFixSkill);
}

// Re-export the individual definitions for callers (smoke / tests / future
// loaders that want to override a specific skill).
export {
  updateConfigSkill,
  batchSkill,
  skillifySkill,
  rememberSkill,
  simplifySkill,
  stuckSkill,
  debugSkill,
  verifySkill,
  commitSkill,
  formatSkill,
  prSkill,
  refactorSkill,
  reviewSkill,
  testSkill,
  tsFixSkill,
};
