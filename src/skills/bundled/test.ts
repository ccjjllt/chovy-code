import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: test
Run the project test suite and surface failures.

### When to use
- The user asks to run tests, verify, or check.
- After applying a fix to confirm the change works.
- Before opening a PR.

### Test runner detection (in priority order)
1. \`bun test\` if \`bun.lockb\` is present.
2. \`npm test\` / \`pnpm test\` / \`yarn test\` based on lockfile.
3. \`pytest\` for Python (\`pyproject.toml\` / \`requirements.txt\`).
4. \`cargo test\` for Rust.
5. \`go test ./...\` for Go.

### Steps
1. Detect runner. If user named a specific test file / pattern, scope to it.
2. Run with verbose output captured.
3. If exit ≠ 0:
   a. Quote the FIRST failure (file:line + assertion message).
   b. Diagnose: read the test source, the implementation it covers, recent
      diffs.
   c. Propose a fix BEFORE applying. If fix is < 5 lines, apply + retest;
      otherwise pause for user confirmation.
4. If exit = 0, report pass count + duration.

### Output contract
- Never claim "tests pass" without running them.
- Don't run flaky tests in a loop expecting them to "pass eventually" —
  flakiness is itself a failure.`;

export const testSkill: Skill = {
  name: "test",
  summary: "Detect and run the project test suite; diagnose first failure.",
  triggers: {
    keywords: ["test", "tests", "测试", "verify", "check"],
    when: "on-request",
  },
  provides: ["run-tests"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 300,
};
