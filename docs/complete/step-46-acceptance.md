# Step 46 Acceptance

## Goal
Implement HeaderBar v2 chip system and theme integration.

## Completed Work
1. Re-implemented `HeaderBar` into smaller component chips inside `src/cli/components/chips`.
2. Developed generic `<Chip />` component and specialized chips for Mode, Provider/Model, Context Tokens, Cost, Swarm, and Goal.
3. Implemented `chooseChips` algorithm to drop chips sequentially from right-to-left (Swarm -> Goal -> Cost -> Ctx) when the terminal width does not have enough capacity.
4. Integrated `TerminalCapsContext` and `stringWidth` functions to correctly compute layout metrics with CJK character awareness.
5. Wired up `useTheme()` logic to correctly style `HeaderBar` borders and the `ModeChip` color according to the active theme.
6. Passed `goalSummary` snapshot safely through `repl.tsx` into `HeaderBar`.
7. Created a smoke test script `scripts/smoke-step46.tsx` and successfully executed it to verify rendering behaviour. All TS checks pass.

## Non-Breaking Contracts
- Kept the original `HeaderBar.tsx` props (`mode`, `provider`, `model`, `budget`, `swarm`).
- Extended with optional `goal?: GoalChipSnapshot`.
- All `BudgetSnapshot` structure preserved.
