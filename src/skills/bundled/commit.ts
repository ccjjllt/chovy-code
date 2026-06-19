import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: commit
Generate a Conventional Commits message for the staged changes and run \`git commit\`.

### When to use
- The user asks to commit, save, or finalize current work.
- A recent \`git diff\` / \`git status\` tool call confirms staged or modified files.

### Steps
1. Inspect changes: run \`git status -s\` and \`git diff --stat\` if not already visible.
2. Choose ONE Conventional Commits prefix:
   - \`feat:\` user-visible feature.
   - \`fix:\` bug fix.
   - \`refactor:\` no behavior change.
   - \`docs:\` documentation only.
   - \`test:\` tests only.
   - \`chore:\` build / tooling / config.
3. Write a subject ≤ 72 chars: \`<type>(<scope>): <imperative summary>\`.
4. If the change is large, add a body explaining *why* (not what — the diff
   already shows what). Wrap at 72 chars.
5. Run \`git commit -m "<subject>"\` (or \`-m "<subject>" -m "<body>"\`).
6. NEVER pass \`--no-verify\` (AGENTS.md §5).

### Output contract
- One commit per logical change. If staged diff spans unrelated areas, ask
  the user whether to split before committing.
- Do not push unless the user asked.`;

export const commitSkill: Skill = {
  name: "commit",
  summary: "Generate a Conventional Commits message and run git commit on staged changes.",
  triggers: {
    keywords: ["commit", "提交"],
    patterns: [/\bgit\s+commit\b/i],
    when: "on-request",
  },
  provides: ["conventional-commits"],
  conflicts: ["legacy-commits"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 400,
};
