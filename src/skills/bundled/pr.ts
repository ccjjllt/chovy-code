import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: pr
Draft a pull request: branch, commit, push, open via \`gh pr create\`.

### When to use
- The user asks to open a PR / pull request / merge request.
- After commit(s) on a feature branch are ready to share.

### Steps
1. Verify branch: \`git branch --show-current\`. If on \`main\` (or
   \`master\`), refuse and ask user to create a feature branch first
   (AGENTS.md §10 default-branch protection).
2. Verify clean state: \`git status -s\` should show no unstaged work
   that wasn't intentionally left out.
3. Push branch: \`git push -u origin <branch>\` (NEVER \`--force\` /
   \`--force-with-lease\` without explicit user request — AGENTS.md §5).
4. Draft PR title: derived from the most recent commit subject (or
   user-supplied title).
5. Draft PR body using template:
   \`\`\`
   ## What
   <one-line summary>

   ## Why
   <motivation; link to issue if any>

   ## Tests
   - [ ] <how the change is verified>

   ## Risks
   - <known unknowns>
   \`\`\`
6. Run \`gh pr create --title "<title>" --body "<body>"\` (or write to a
   temp file and use \`--body-file\`).

### Output contract
- Surface the PR URL from \`gh pr create\` output.
- Do not assign reviewers / labels unless the user asked.`;

export const prSkill: Skill = {
  name: "pr",
  summary: "Push branch + open pull request with a structured body.",
  triggers: {
    keywords: ["pr", "pull request", "pull-request", "merge request", "合并请求"],
    patterns: [/\bgh\s+pr\b/i],
    when: "on-request",
  },
  requires: ["commit"],
  provides: ["pr-flow"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 400,
};
