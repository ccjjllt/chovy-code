/**
 * Permission modes (step-12).
 *
 * The canonical `PermissionMode` union is **frozen in `src/config/config.ts`**
 * (it's the source consumed by the CLI flag + config file + env). We
 * re-export it here so harness consumers import from one place, but we do
 * NOT redeclare the literal union — that would split the source and let the
 * two drift (the same "single source" rule §17 applies to `AgentRole`).
 *
 * The 5 modes (from `docs/step-12-permission-engine.md §5 种模式`):
 *
 *   - `default`            — ask every time; the safe default.
 *   - `plan`               — read-only; any mutate/exec is denied outright.
 *   - `acceptEdits`        — file edits auto-allowed; everything else still asks.
 *   - `auto`               — heuristic + allowlist (no small-model classifier;
 *                            chovy-code ships without one per AGENTS.md §5).
 *   - `bypassPermissions`  — almost everything allowed (still bound by the
 *                            bypass-immune safety checks in `./safety.ts`).
 *
 * `dontAsk` is NOT a mode — it's an engine-state flag (set for non-TTY /
 * background sub-agents) that converts `ask` outcomes to `deny`. Keeping it
 * out of the mode union avoids a 6th mode that the CLI/config would have to
 * validate.
 */

// Single source: the literal union + readonly list live in config.
export type { PermissionMode } from "../../config/index.js";
import type { PermissionMode } from "../../config/index.js";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;

/** Type guard: is `s` one of the 5 valid modes? */
export function isValidPermissionMode(s: string): s is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(s);
}

/**
 * Parse a mode string. Unknown / empty ⇒ `default` (fail-safe: an invalid
 * `--permission-mode` flag should never silently enable `bypassPermissions`).
 * The CLI layer also validates and rejects unknown modes with a clear error;
 * this helper is the defense-in-depth for env / config / programmatic paths.
 */
export function permissionModeFromString(s: string | undefined): PermissionMode {
  if (s && isValidPermissionMode(s)) return s;
  return "default";
}

/**
 * Does the mode auto-allow *mutating* file operations?
 *   - `acceptEdits` — yes (that's its whole purpose).
 *   - `bypassPermissions` — yes (safety checks still apply in `engine.ts`).
 *   - `default` / `plan` / `auto` — no (auto uses its own allowlist path).
 */
export function modeAllowsMutate(mode: PermissionMode): boolean {
  return mode === "acceptEdits" || mode === "bypassPermissions";
}

/**
 * Is the mode strictly read-only? `plan` denies every mutate/exec up front
 * (L4 in the engine) — it's the "look, don't touch" mode.
 */
export function modeIsReadOnly(mode: PermissionMode): boolean {
  return mode === "plan";
}

/**
 * Should the engine consult the user for an `ask` outcome in this mode?
 * `bypassPermissions` short-circuits to allow at L2 before reaching the ask
 * layer, so this is only consulted for the non-bypass modes. `plan` still
 * asks for read-only tools that lack an allow rule (e.g. an unknown MCP
 * read tool) — it only *denies* mutate/exec.
 */
export function modePromptsByDefault(mode: PermissionMode): boolean {
  return mode !== "bypassPermissions";
}
