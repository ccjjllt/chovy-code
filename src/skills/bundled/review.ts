import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: review
Review changed code for quality, reuse, correctness, and risk.

### When to use
- The user asks to review, audit, critique, or check recent changes.
- After a series of edits before committing or opening a PR.

### Review checklist (apply each to every changed file)
1. **Reuse** — does the change duplicate something elsewhere in the repo?
   Run \`grep\` for similar patterns before claiming "no duplicate".
2. **Boundaries** — does the change cross a public API / module boundary
   that other callers might depend on? Check imports of the changed exports.
3. **Edge cases** — null / empty / very large / unicode / Windows paths.
4. **Errors** — every \`throw\`, \`catch\`, \`?? throw\` reviewed for
   semantics. Are errors swallowed silently?
5. **Tests** — does the change need a test? Is an existing test updated?
6. **Type safety** — \`any\`, \`as unknown as\`, untyped JSON parses, missing
   discriminants in unions.
7. **Concurrency** — racey \`await\` followed by mutation of shared state.
8. **Performance** — N+1 loops, sync I/O on hot paths, regex in tight loops.

### Output contract
- Issue list with file:line references and severity (\`blocker\` / \`major\` /
  \`minor\` / \`nit\`).
- For each blocker / major: propose a concrete fix.
- End with a one-line verdict: \`PASS\`, \`PASS_WITH_NITS\`, or \`CHANGES_REQUESTED\`.`;

export const reviewSkill: Skill = {
  name: "review",
  summary: "Review changed code for reuse, quality, edge cases, and tests; emit a verdict.",
  triggers: {
    keywords: ["review", "audit", "critique", "审查", "评审"],
    when: "on-request",
  },
  provides: ["code-review"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 600,
};
