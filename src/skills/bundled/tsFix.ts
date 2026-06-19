import type { Skill } from "../../types/skill.js";

const SYSTEM_FRAGMENT = `## Skill: ts-fix
Iterate \`tsc --noEmit\` to drive TypeScript errors to zero.

### When to use
- A typecheck has failed (recent tool output mentions \`error TS\` or
  "TypeScript error").
- The user asks to fix types / typecheck / tsc errors.
- Before commit, when the project enforces strict types.

### Steps (loop)
1. Run \`bun run typecheck\` (or \`tsc --noEmit\` / \`npx tsc --noEmit\` if
   no script).
2. If exit = 0, report and stop.
3. Else parse the FIRST error block:
   - File path + line + column.
   - Error code (e.g. \`TS2345\`).
   - Message.
4. Read the offending file ±20 lines around the error.
5. Diagnose:
   - \`TS2304\` (cannot find name) → missing import / typo.
   - \`TS2345\` (argument not assignable) → type mismatch in a call.
   - \`TS2322\` (type X not assignable to Y) → assignment / return mismatch.
   - \`TS2339\` (no property X on Y) → wrong type / missing field.
   - \`TS18047\` / \`TS2531\` (possibly null/undefined) → guard or non-null
     assert (only when truly impossible).
6. Apply the SMALLEST fix that resolves THIS error without introducing
   new \`any\` / \`as unknown as\`. Prefer narrowing, type guards, or
   adding optional fields over widening to \`any\`.
7. Goto 1. Cap at 25 iterations; if not converging, stop and ask user.

### Output contract
- One error fixed per iteration. Show the error → fix → next-error
  flow so the user can pause if a fix looks wrong.
- Run formatter after the loop if 'format' skill is active.
- NEVER suppress errors with \`@ts-ignore\` / \`@ts-expect-error\` to
  reach zero — only as a last resort with a written justification.`;

export const tsFixSkill: Skill = {
  name: "ts-fix",
  summary: "Loop tsc --noEmit, diagnose and fix one TS error at a time.",
  triggers: {
    keywords: [
      "typecheck",
      "tsc",
      "ts error",
      "ts errors",
      "类型错误",
      "类型检查",
      "type error",
      "fix",
      "bug",
      "修复",
    ],
    patterns: [/\bTS\d{4,5}\b/],
    when: "on-request",
  },
  requires: ["format"],
  provides: ["typecheck-loop"],
  systemFragment: SYSTEM_FRAGMENT,
  budgetTokens: 600,
};
