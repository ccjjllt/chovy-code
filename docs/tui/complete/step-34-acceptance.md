# Step 34 Acceptance

## Checklist
- [x] Schema extension for `keybindings: Record<string, string | null>` implemented in `src/config/config.ts`.
- [x] Central registry and `DEFAULT_BINDINGS` representing over 35 default actions implemented in `src/keybindings/index.ts` and `src/keybindings/defaults.ts`.
- [x] Hotkey/chord parser and matcher with protection against using `Esc` as a chord head created in `src/keybindings/parse.ts`.
- [x] Config persistence interface created in `src/keybindings/persist.ts` proxying setting adjustments.
- [x] Conflict detection grouping duplicate keybindings by `scope` (or overlap with `global`) created in `src/keybindings/conflict.ts`.
- [x] React hook `useKeybinding` listening to matching shortcuts and safely checking `isTTY` and managing the 200ms chord window state created in `src/keybindings/useKeybinding.ts`.
- [x] `bun run typecheck` passes successfully.
- [x] Mock unit tests implemented in `scripts/smoke-step34.ts` pass successfully.

All requirements for Step 34 have been successfully met.
