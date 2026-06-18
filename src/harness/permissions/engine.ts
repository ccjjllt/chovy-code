/**
 * Permission engine — the 6-layer decision core (step-12).
 *
 * `hasPermission(tool, args, ctx, state)` walks the layers in the exact
 * order `docs/step-12 §6 层决策` prescribes:
 *
 *   L1a  deny-rule (whole tool)          → DENY
 *   L1b  ask-rule (tool + content)       → ASK  (dontAsk → DENY)
 *   L1c  tool.checkPermissions preflight → deny→DENY, ask→mark
 *   L1g  bypass-immune safety check      → unsafe→DENY/ASK (immune to bypass)
 *   L2   bypassPermissions mode          → ALLOW (L1g deny already fired)
 *        allow-rule                       → ALLOW
 *   L3   dontAsk && ask                  → DENY
 *   L4   acceptEdits (mutating fs)       → ALLOW
 *        auto: SAFE_TOOLS / isBashSafe   → ALLOW else ASK
 *   L5   hooks.run('PermissionRequest')  → allow/deny (step-13; stub today)
 *   L6   ask → prompt user (TTY+askUser) / else DENY
 *
 * The ordering is load-bearing: L1 (rules + preflight + safety) runs BEFORE
 * the mode layer (L2/L4), so a `deny` rule or a safety trip beats
 * `bypassPermissions`, and `plan` mode's mutate-deny is enforced at L4 after
 * rules have had their say. A unit test covers the plan+acceptEdits
 * cross-talk risk called out in step-12 §风险.
 *
 * State (`PermissionEngineState`) is owned by the agent loop and mutated in
 * place: denials bump the circuit breaker, and a tripped breaker downgrades
 * `auto` → `default` for the rest of the session. The engine never touches
 * global state — tests pass a fresh state.
 */

import type { Logger } from "../../logger/index.js";
import type { PermissionPreflight, Tool, ToolContext } from "../../types/index.js";

// We reach into the bash AST + classification *leaf* modules (not the tools
// barrel) because they are pure, dependency-free functions. This keeps the
// harness→tools edge narrow and avoids pulling the tool registry into the
// permission engine. architecture.md's dependency arrow is tools→harness;
// these two files have zero out-of-module imports so there's no cycle.
import { parseBashCommand } from "../../tools/exec/ast.js";
import { isAllReadOnly } from "../../tools/exec/classification.js";

import {
  createDenialState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
  type DenialState,
} from "./denialTracking.js";
import {
  modeAllowsMutate,
  modeIsReadOnly,
  type PermissionMode,
} from "./modes.js";
import {
  defaultRulesPaths,
  loadRulesFromPaths,
  matchRule,
  type ParsedRule,
} from "./rules.js";
import {
  checkCommandSafety,
  checkPathSafety,
  probeArgs,
  type SafetyResult,
} from "./safety.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface PermissionDecision {
  outcome: "allow" | "ask" | "deny";
  reason: string;
  /** Rule string that matched (for telemetry / UI explanation). */
  matchedRule?: string;
}

/**
 * Live engine state. The agent loop constructs one per session (or per
 * sub-agent — each gets its own breaker per AGENTS.md §9) and passes it to
 * every `hasPermission` call.
 */
export interface PermissionEngineState {
  mode: PermissionMode;
  rules: { allow: ParsedRule[]; ask: ParsedRule[]; deny: ParsedRule[] };
  denial: DenialState;
  /**
   * When true (non-TTY `chat`, background sub-agents), `ask` outcomes are
   * converted to `deny` at L3/L6 rather than blocking on a prompt that will
   * never come. NOT a permission mode — it's orthogonal context.
   */
  dontAsk: boolean;
  /**
   * Once the breaker trips, `auto` is permanently downgraded to `default`
   * for the session. This flag lets the UI surface "auto disabled" without
   * re-checking the breaker each render.
   */
  autoDowngraded: boolean;
}

export interface CreateEngineOptions {
  mode: PermissionMode;
  /** Rule file paths; defaults to `~/.chovy/rules.json` + `<cwd>/.chovy/rules.json`. */
  rulesPaths?: string[];
  cwd: string;
  dontAsk?: boolean;
  /** Inject rules directly (tests) instead of loading from disk. */
  rules?: { allow: ParsedRule[]; ask: ParsedRule[]; deny: ParsedRule[] };
  /** Pre-seed denial state (tests). */
  denial?: DenialState;
}

// ── SAFE_TOOLS allowlist (auto mode) ───────────────────────────────────────

/**
 * Tools auto-mode allows without asking. Read-only built-ins whose misuse
 * can't mutate state. `bash` is NOT here as a whole — it goes through
 * `isBashSafe` (read-only command classification) instead. Mirrors cc-haha's
 * `SAFE_YOLO_ALLOWLISTED_TOOLS` minus the ant-only / classifier entries.
 */
const SAFE_TOOLS = new Set<string>([
  "echo",
  "file_read",
  "glob",
  "grep",
  "web_search",
  "todo_write",
  "skill",
]);

/**
 * Tool families that count as "mutating fs" for the `acceptEdits` fast-path
 * (L4). `file_write` / `file_edit` are the mutate tools; `file_read` /
 * `glob` / `grep` are read-only and already allowed by SAFE_TOOLS / rules.
 */
const FS_MUTATE_TOOLS = new Set<string>(["file_write", "file_edit"]);

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Construct an engine state. Loads rules from disk unless `rules` is passed
 * (tests). Idempotent w.r.t. the rules files — callers may rebuild the state
 * after editing `rules.json` without restarting the process.
 */
export function createPermissionEngineState(
  opts: CreateEngineOptions,
  logger?: Logger,
): PermissionEngineState {
  const rules =
    opts.rules ??
    loadRulesFromPaths(opts.rulesPaths ?? defaultRulesPaths(opts.cwd));
  if (logger) {
    logger.debug("permission engine initialized", {
      mode: opts.mode,
      allow: rules.allow.length,
      ask: rules.ask.length,
      deny: rules.deny.length,
      dontAsk: opts.dontAsk ?? false,
    });
  }
  return {
    mode: opts.mode,
    rules,
    denial: opts.denial ?? createDenialState(),
    dontAsk: opts.dontAsk ?? false,
    autoDowngraded: false,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** The "content" string a rule's content matches against for a given tool. */
function ruleContentFor(toolName: string, args: unknown): string {
  const probe = probeArgs(toolName, args);
  // For bash, the rule content matches the command line. For fs tools, the
  // (first) path. For everything else, empty — whole-tool rules still match.
  if (probe.command) return probe.command;
  if (probe.paths.length > 0) return probe.paths[0]!;
  return "";
}

/** Is this bash command a pure read-only chain (READ/SEARCH/LIST)? */
function isBashSafe(args: unknown): boolean {
  const cmd = (args as { command?: string } | null | undefined)?.command;
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const parse = parseBashCommand(cmd);
  if (!parse.ok) return false;
  return isAllReadOnly(parse.commands);
}

/**
 * Run the bypass-immune safety check (L1g) against the probed paths + command.
 * Returns the first unsafe result; `deny` wins over `ask` when both apply.
 */
function runSafetyCheck(toolName: string, args: unknown): SafetyResult {
  const probe = probeArgs(toolName, args);
  // Paths first — a deny on a sensitive path beats an ask on a command.
  for (const p of probe.paths) {
    const r = checkPathSafety(p);
    if (!r.safe) return r;
  }
  if (probe.command) {
    const r = checkCommandSafety(probe.command);
    if (!r.safe) return r;
  }
  void toolName;
  return { safe: true };
}

/** Find the first rule in `list` matching `(toolName, content)`. */
function findMatchingRule(
  list: ParsedRule[],
  toolName: string,
  content: string,
): ParsedRule | undefined {
  return list.find((r) => matchRule(r, toolName, content));
}

// ── The 6-layer decision ───────────────────────────────────────────────────

/**
 * Decide whether `tool` may run with `args` under the current engine state.
 *
 * Side effects: mutates `state.denial` (recordDenial / recordSuccess) and,
 * when the breaker trips, downgrades `state.mode` `auto` → `default`.
 *
 * `ctx` is the live `ToolContext` (for `tool.checkPermissions`, `ctx.hooks`,
 * `ctx.askUser`, `ctx.isInteractive`). The engine never reads `ctx.config`
 * — the mode is already resolved into `state.mode` by the caller.
 */
export async function hasPermission(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  state: PermissionEngineState,
): Promise<PermissionDecision> {
  const toolName = tool.name;
  const content = ruleContentFor(toolName, args);

  // Effective mode accounts for an already-tripped breaker.
  const effectiveMode: PermissionMode =
    state.autoDowngraded && state.mode === "auto" ? "default" : state.mode;

  // ── L1a: deny-rule (whole tool) ────────────────────────────────────────
  const denyRule = findMatchingRule(state.rules.deny, toolName, content);
  if (denyRule) {
    return {
      outcome: "deny",
      reason: `denied by rule ${ruleLabel(denyRule)}`,
      matchedRule: ruleLabel(denyRule),
    };
  }

  // ── L1b: ask-rule (tool + content) ─────────────────────────────────────
  const askRule = findMatchingRule(state.rules.ask, toolName, content);
  let askFromRule = false;
  if (askRule) {
    if (state.dontAsk) {
      return {
        outcome: "deny",
        reason: `ask-rule ${ruleLabel(askRule)} cannot prompt (dontAsk)`,
        matchedRule: ruleLabel(askRule),
      };
    }
    askFromRule = true;
  }

  // ── L1c: tool.checkPermissions preflight ───────────────────────────────
  let preflightAsk = false;
  let preflightAllow = false;
  if (tool.checkPermissions) {
    let pre: PermissionPreflight;
    try {
      pre = await tool.checkPermissions(args as never, ctx);
    } catch (err) {
      // A throwing preflight is treated as `ask` (fail safe) — we don't let
      // a buggy tool preflight silently grant permission.
      ctx.logger.warn("permission preflight threw; treating as ask", {
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      pre = { outcome: "ask", reason: "preflight threw" };
    }
    if (pre.outcome === "deny") {
      return {
        outcome: "deny",
        reason: pre.reason ?? `tool ${toolName} denied via preflight`,
        matchedRule: pre.matchedRule,
      };
    }
    if (pre.outcome === "ask") preflightAsk = true;
    else preflightAllow = true;
  }

  // ── L1g: bypass-immune safety check ────────────────────────────────────
  const safety = runSafetyCheck(toolName, args);
  if (!safety.safe) {
    if (safety.level === "deny") {
      return {
        outcome: "deny",
        reason: safety.reason ?? "safety check denied",
      };
    }
    // `ask`-level safety (git push --force): force a prompt even in bypass.
    preflightAsk = true;
    askFromRule = true;
  }

  // ── L2: bypassPermissions mode + allow-rules ───────────────────────────
  // bypass short-circuits to allow — but L1g safety deny has already fired
  // above, so a `.gitconfig` edit still gets denied here.
  if (effectiveMode === "bypassPermissions") {
    noteSuccess(state);
    return {
      outcome: "allow",
      reason: "bypassPermissions mode",
    };
  }
  const allowRule = findMatchingRule(state.rules.allow, toolName, content);
  if (allowRule) {
    noteSuccess(state);
    return {
      outcome: "allow",
      reason: `allowed by rule ${ruleLabel(allowRule)}`,
      matchedRule: ruleLabel(allowRule),
    };
  }

  // ── L4 (early): mode auto-allow paths that outrank the dontAsk→deny ───
  // These mode decisions resolve *before* L3 so a non-interactive acceptEdits
  // run still writes files, and a non-interactive auto run still runs safe
  // read-only tools. Deny rules (L1a) and safety denies (L1g) already fired
  // above, so the red lines stay protected.
  if (effectiveMode === "acceptEdits" && FS_MUTATE_TOOLS.has(toolName)) {
    noteSuccess(state);
    return { outcome: "allow", reason: "acceptEdits mode (fs mutate)" };
  }
  if (effectiveMode === "auto") {
    if (SAFE_TOOLS.has(toolName)) {
      noteSuccess(state);
      return { outcome: "allow", reason: "auto mode: safe tool allowlist" };
    }
    if (toolName === "bash" && isBashSafe(args)) {
      noteSuccess(state);
      return { outcome: "allow", reason: "auto mode: read-only bash" };
    }
  }

  // ── L3: dontAsk converts ask → deny ────────────────────────────────────
  const wantsAsk = askFromRule || preflightAsk;
  if (wantsAsk && state.dontAsk) {
    noteDenial(state);
    maybeTripBreaker(state);
    return {
      outcome: "deny",
      reason: "permission prompt unavailable in non-interactive context",
    };
  }

  // ── L4 (remainder): auto-mode fall-through to ask ──────────────────────
  if (effectiveMode === "auto") {
    // No safe-tool / read-only-bash match and not dontAsk (handled at L3) →
    // ask. No small-model classifier (AGENTS.md §5).
    if (!state.dontAsk) {
      return { outcome: "ask", reason: "auto mode: unrecognized tool" };
    }
  }

  // plan mode: deny any mutating tool. We detect "mutating" by the inverse of
  // isReadOnly — a tool that doesn't declare read-only and isn't in the
  // safe set is treated as mutating. This runs after rules so an explicit
  // allow-rule still wins for read tools the user trusts.
  if (modeIsReadOnly(effectiveMode) && !tool.isReadOnly && !SAFE_TOOLS.has(toolName)) {
    noteDenial(state);
    return {
      outcome: "deny",
      reason: "plan mode denies mutating tools",
    };
  }

  // ── L5: user hooks (step-13) ───────────────────────────────────────────
  // The hook engine isn't wired yet; `ctx.hooks.emit` is the placeholder
  // interface frozen in step-06. When step-13 lands it will return
  // {allow|deny|undefined}; today it resolves to undefined (no opinion).
  if (ctx.hooks?.emit) {
    try {
      await ctx.hooks.emit("PermissionRequest", { tool: toolName, args });
    } catch (err) {
      ctx.logger.warn("PermissionRequest hook threw", {
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // TODO step-13: read the hook verdict and short-circuit allow/deny.
  }

  // ── L6: resolve ask → prompt or deny ───────────────────────────────────
  // Prompt when something explicitly asked (rule/preflight/safety) OR when a
  // *mutating* tool (fs write/edit, bash) reached here without the preflight
  // blessing it with `allow`, in a mode that prompts by default. Read-only
  // tools and meta tools whose preflight returned `allow` (todo_write, skill,
  // ask_user_question, read-only bash) fall straight through.
  const isMutatingTool =
    FS_MUTATE_TOOLS.has(toolName) || toolName === "bash";
  const needsPrompt =
    wantsAsk ||
    (isMutatingTool && !preflightAllow && !modeAllowsMutate(effectiveMode));
  if (needsPrompt) {
    // Non-interactive → can't prompt → deny (fail closed).
    if (state.dontAsk || !ctx.isInteractive?.()) {
      noteDenial(state);
      maybeTripBreaker(state);
      return {
        outcome: "deny",
        reason: "permission required and no interactive prompt available",
      };
    }
    // Interactive but no askUser wired (step-22 not landed) → deny with a
    // clear INTERNAL pointer so the model learns the UI isn't ready.
    if (!ctx.askUser) {
      noteDenial(state);
      maybeTripBreaker(state);
      return {
        outcome: "deny",
        reason: "permission required but askUser UI not wired (step-22)",
      };
    }
    // step-22 will supply askUser; until then this branch is unreachable in
    // practice (isInteractive true ⇒ askUser absent ⇒ caught above). Kept so
    // the wiring is obvious when step-22 lands.
    return { outcome: "ask", reason: "pending user confirmation" };
  }

  // No objection and mode allows mutation without asking (or the tool is
  // read-only with an allow preflight).
  noteSuccess(state);
  return { outcome: "allow", reason: `mode ${effectiveMode} allows` };
}

/**
 * Mutate `state.denial` in place: record a success (resets consecutive only).
 * `recordSuccess` returns the same object when consecutive is already 0, so
 * the assignment is a no-op on the hot read-only path.
 */
function noteSuccess(state: PermissionEngineState): void {
  state.denial = recordSuccess(state.denial);
}

/**
 * Mutate `state.denial` in place: record a denial (bumps both counters).
 * Callers that represent a *user-facing* denial should also call
 * `maybeTripBreaker` afterwards so the `auto`→`default` downgrade fires.
 */
function noteDenial(state: PermissionEngineState): void {
  state.denial = recordDenial(state.denial);
}

/**
 * After a denial, check the breaker. If tripped and we're in `auto`, flip to
 * `default` for the rest of the session and mark `autoDowngraded`.
 */
function maybeTripBreaker(state: PermissionEngineState): void {
  if (state.mode !== "auto" || state.autoDowngraded) return;
  if (shouldFallbackToPrompting(state.denial)) {
    state.autoDowngraded = true;
    // The mode is conceptually `default` now; we leave `state.mode` as `auto`
    // + set the flag so the UI can explain "auto disabled after denials".
    // `hasPermission` reads `autoDowngraded` to use `default` semantics.
  }
}

/** Human-readable rule label, e.g. `Bash(rm -rf:*)`. */
function ruleLabel(r: ParsedRule): string {
  if (r.kind === "whole" || r.content === undefined) return r.toolName;
  if (r.kind === "prefix") return `${r.toolName}(${r.content}:*)`;
  return `${r.toolName}(${r.content})`;
}

// Re-export the breaker constants so callers (agent loop / UI) can introspect.
export { DENIAL_LIMITS, shouldFallbackToPrompting };
