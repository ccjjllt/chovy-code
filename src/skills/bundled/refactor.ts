import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: refactor
Restructure code without changing observable behavior. Always run formatter
+ tests after.

### When to use
- The user asks to refactor, simplify, rename, extract, inline, or split.
- The codebase has clear smells: long functions, duplicated logic, mixed
  abstraction levels, leaky abstractions.

### Steps
1. **Anchor** — find tests that exercise the target. If none, write a
   characterization test FIRST.
2. **Identify** the smell explicitly: \`long function\` / \`duplication\` /
   \`feature envy\` / \`primitive obsession\` / \`shotgun surgery\`.
3. **Plan** the smallest mechanical move (extract method, rename, inline
   variable). Avoid combining moves.
4. **Apply** with \`file_edit\` (preserve indentation, no behavioral change).
5. **Verify** — run tests; if formatter is loaded (skill 'format' is active),
   run it too.
6. **Commit** with \`refactor:\` prefix only if behavior is provably
   unchanged.

### Refactor moves available
- Extract function / variable / module
- Rename (file, symbol, parameter)
- Inline (variable, function)
- Move (file, member)
- Replace conditional with polymorphism / table
- Replace magic literal with named constant

### Output contract
- One refactor move per turn. If the user asked for a chain, propose the
  chain as a numbered list, then apply step 1.
- If tests fail after the move, REVERT and report — never "fix forward".`;

export const refactorSkill: Skill = {
  name: "refactor",
  summary: "Apply behavior-preserving refactor moves with formatter + test gates.",
  triggers: {
    keywords: ["refactor", "重构", "simplify", "extract", "rename"],
    when: "on-request",
  },
  requires: ["format"],
  provides: ["safe-refactor"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 500,
};
