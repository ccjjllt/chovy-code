import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: format
Run the project's formatter / linter to normalize style after edits.

### When to use
- After any \`file_write\` or \`file_edit\` that touches source code.
- Before \`commit\` (the 'commit' skill triggers this skill if active).
- The user explicitly asks to format / lint / tidy.

### Formatter detection (in priority order)
1. \`bun run format\` if present in \`package.json\` scripts.
2. \`bun run lint:fix\` / \`npm run lint -- --fix\` if present.
3. \`prettier --write <files>\` if \`.prettierrc*\` exists.
4. \`biome format --write <files>\` if \`biome.json\` exists.
5. \`eslint --fix <files>\` if \`.eslintrc*\` / \`eslint.config.*\` exists.
6. \`gofmt -w\` for Go, \`cargo fmt\` for Rust, etc.

### Steps
1. Detect formatter via \`file_read\` of \`package.json\` (or via \`bash\`
   listing config dotfiles).
2. Run the chosen command on ONLY the changed files (not the whole repo).
3. If exit code ≠ 0, report the formatter's stderr verbatim and stop.

### Output contract
- Always say which formatter ran. Never silently skip.
- If no formatter is configured, say so once and ask if the user wants
  one set up — do not invent style rules.`;

export const formatSkill: Skill = {
  name: "format",
  summary: "Detect and run the project formatter on changed files.",
  triggers: {
    keywords: ["format", "lint", "格式化", "tidy", "prettier"],
    when: "pre-tool",
  },
  provides: ["format"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 200,
};
