import type { PermissionMode } from "../config/index.js";
import type { CreateGoalInput, RunGoalResult } from "../goals/index.js";
import type { GoalState } from "../types/index.js";
import { goalSlashEntry } from "./slashCommands/goal.js";
import { checkpointSlashEntry } from "./slashCommands/checkpoint.js";
import { skillSlashEntry } from "./slashCommands/skill.js";
import { memSlashEntry } from "./slashCommands/mem.js";
import { themeSlashEntry } from "./slashCommands/theme.js";
import { langSlashEntry } from "./slashCommands/lang.js";
import { buddySlashEntry } from "./slashCommands/buddy.js";
import { t } from "../i18n/index.js";

/**
 * Read-only/mutator surface that slash command handlers receive. Keeping
 * this an interface (rather than passing the full REPL component state)
 * lets steps 22/23/25 layer on extra capabilities without rewriting the
 * existing handlers.
 */
export interface ReplCtx {
  setMode(mode: PermissionMode): void;
  appendSystem(text: string): void;
  clearMessages(): void;
  toggleHelp(show?: boolean): void;
  setGoal(goal: string | null): void;
  exit(): void;
  listProviders(): string[];
  /** TODO step-22: real list pulled from the lifecycle registry. */
  listAgents(): string[];
  /** TODO step-29: real list pulled from the skill graph. */
  listSkills(): string[];
  /**
   * step-23: goal-loop runtime injected by the REPL. Absent in non-REPL
   * test contexts — `/goal` handler bails with an INTERNAL message when
   * undefined. The shape is intentionally narrow (the REPL owns the
   * provider/model + queryEngine wiring; the slash handler is UI-only).
   */
  goal?: ReplGoalRuntime;
  /**
   * step-26: checkpoint-writer runtime injected by the REPL. Absent in
   * headless contexts — `/checkpoint` handler reports a clean error
   * when undefined. The REPL owns provider/model/cwd binding so the
   * slash handler stays UI-only (mirrors the §goal pattern).
   */
  checkpoint?: ReplCheckpointRuntime;
  /**
   * step-29: CSG skill runtime injected by the REPL. Absent in headless
   * contexts — `/skill` handler reports a clean error when undefined.
   * UI-only; the runtime closes over the live cwd / threadId / session
   * (so manual activations land on the same `ToolSession.activeSkillFragments`
   * the engine reads on the next round).
   */
  skill?: ReplSkillRuntime;
  /** Run the same config wizard used by `chovy config`. */
  config?: ReplConfigRuntime;
  /**
   * step-24/25: memory store runtime injected by the REPL. Absent in
   * non-REPL contexts — `/mem` reports a clean error when undefined.
   * UI-only; the runtime closes over cwd and opens a fresh store per call.
   */
  mem?: ReplMemRuntime;
}

/**
 * Runtime hooks the REPL injects so `/goal` doesn't need to import the
 * QueryEngine / providers (keeps `cli/slashCommands/goal.ts` UI-only).
 */
export interface ReplGoalRuntime {
  /** REPL session id ⇒ goal threadId. */
  threadId: string;
  /** Current cwd ⇒ goal persistence dir. */
  cwd: string;
  /** Create + spawn the goal loop. Returns the freshly created GoalState. */
  startGoal(input: CreateGoalInput): Promise<GoalState>;
  /** Cancel the in-flight loop (idempotent). */
  cancelGoal(): void;
  /** Re-enter the loop with an existing (paused / resumed) goal. */
  resumeGoalLoop(goal: GoalState): Promise<RunGoalResult>;
  /** Find the most-recent paused goal on disk for this thread. */
  findPausedGoal(): Promise<GoalState | null>;
  /** Notify the REPL UI of the new goal state (or clear). */
  setReplGoal(goal: GoalState | null): void;
}

/**
 * Runtime hooks for `/checkpoint` (step-26). Same UI-only contract as
 * `ReplGoalRuntime`: the REPL closes over `provider` / `model` / `cwd` /
 * the live message tail and exposes the narrow surface the slash handler
 * needs (`triggerNow` + `list`). The handler never imports
 * `memory/checkpointWriter` directly so cli/slashCommands stays a leaf.
 */
export interface ReplCheckpointRuntime {
  /** Force an immediate checkpoint via reason `'manual'`. Resolves with
   *  a short user-visible status string ('ok' / 'fallback' / error msg). */
  triggerNow(): Promise<string>;
  /** List archived checkpoint files (basename + size + iso ts). */
  list(): Promise<{ name: string; bytes: number; ts: string }[]>;
}

/**
 * Per-skill summary row returned by `/skill list`. Pre-formatted by the
 * runtime so the slash handler stays trivial (just `appendSystem`).
 */
export interface ReplSkillListItem {
  name: string;
  summary: string;
  requires: string[];
  provides: string[];
  conflicts: string[];
  budgetTokens: number;
  /** True iff in `session.activeSkillFragments` (auto or manual). */
  active: boolean;
  /** True iff in `session.manualSkillNames`. */
  manual: boolean;
}

/** Dry-run output of `/skill plan`. */
export interface ReplSkillPlanDryRun {
  selected: string[];
  droppedByBudget: string[];
  droppedByConflict: string[];
  missingRequired: string[];
  totalTokens: number;
  budgetTokens: number;
  tags: string[];
}

/**
 * Runtime hooks for `/skill` (step-29). UI-only — the handler imports
 * `src/skills/` (a leaf) but the runtime closes over the live REPL
 * `ToolSession` so manual activations are visible to the next agent
 * round (the engine reads `session.activeSkillFragments` per turn via
 * `runSkillRound`).
 */
export interface ReplSkillRuntime {
  list(): Promise<ReplSkillListItem[]>;
  show(name: string): Promise<string | null>;
  plan(): Promise<ReplSkillPlanDryRun>;
  /** Activate a skill (and its requires); returns a status message. */
  activate(name: string, args?: string): Promise<string>;
  /** Clear all manual + auto activations from the session. */
  clear(): Promise<void>;
}

export interface ReplConfigRuntime {
  run(): Promise<void>;
}

/**
 * Pre-formatted row for `/mem list` (memory store already formats the header
 * line; the slash handler just `appendSystem`s the joined block). Mirrors the
 * `chovy mem list` logger output so REPL and CLI read identically.
 */
export interface ReplMemListItem {
  /** Fully formatted single-line summary, e.g. `mem_xxx  project     decision    imp= 80  ...`. */
  line: string;
}

export interface ReplMemShowResult {
  found: boolean;
  /** Multi-line pretty-print when found, empty when not. */
  block?: string;
}

export interface ReplMemStatsResult {
  /** Multi-line block, e.g. `records   42\npath      ...\nprojectId ...\ndegraded  false`. */
  block: string;
}

/**
 * Runtime hooks for `/mem` (step-24/25). UI-only — the handler imports
 * nothing from the engine/providers; the REPL closes over the live cwd and
 * opens a fresh `MemoryStore` per call (synced from source files). Mirrors
 * `ReplCheckpointRuntime` / `ReplSkillRuntime` (AGENTS.md §16 leaf pattern).
 */
export interface ReplMemRuntime {
  list(opts: {
    layer?: string;
    type?: string;
    limit?: number;
  }): Promise<ReplMemListItem[]>;
  show(id: string): Promise<ReplMemShowResult>;
  search(query: string, opts: {
    bm25?: boolean;
    limit?: number;
    layer?: string;
  }): Promise<ReplMemListItem[]>;
  stats(): Promise<ReplMemStatsResult>;
}

export type SlashHandler = (args: string, ctx: ReplCtx) => Promise<void> | void;

export interface SlashEntry {
  handler: SlashHandler;
  help: string;
}

const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;

function isPermissionMode(s: string): s is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(s);
}

export const slashCommands: Record<string, SlashEntry> = {
  help: {
    help: t("slash.help.desc"),
    handler: (_args, ctx) => { ctx.toggleHelp(true); },
  },

  quit: {
    help: t("slash.quit.desc"),
    handler: (_args, ctx) => { ctx.exit(); },
  },

  clear: {
    help: t("slash.clear.desc"),
    handler: (_args, ctx) => { ctx.clearMessages(); ctx.toggleHelp(false); },
  },

  mode: {
    help: t("slash.mode.desc"),
    handler: (args, ctx) => {
      const v = args.trim();
      if (!v) {
        ctx.appendSystem(`权限模式：${PERMISSION_MODES.join(", ")}`);
        return;
      }
      if (!isPermissionMode(v)) {
        ctx.appendSystem(`未知权限模式：${v}`);
        return;
      }
      ctx.setMode(v);
      ctx.appendSystem(`权限模式 → ${v}`);
    },
  },

  goal: goalSlashEntry,

  checkpoint: checkpointSlashEntry,

  mem: memSlashEntry,
  
  theme: themeSlashEntry,
  
  lang: langSlashEntry,
  
  buddy: buddySlashEntry,

  agents: {
    help: t("slash.agents.desc"),
    handler: (_args, ctx) => {
      const xs = ctx.listAgents();
      ctx.appendSystem(xs.length ? xs.join("\n") : "（暂无活跃子 agent）");
    },
  },

  skill: skillSlashEntry,

  skills: {
    help: t("slash.skills.desc"),
    handler: (_args, ctx) => {
      const xs = ctx.listSkills();
      ctx.appendSystem(xs.length ? xs.join("\n") : "（暂无技能）");
    },
  },

  provider: {
    help: t("slash.provider.desc"),
    handler: (_args, ctx) => {
      ctx.appendSystem(ctx.listProviders().join(", "));
    },
  },

  config: {
    help: t("slash.config.desc"),
    handler: async (_args, ctx) => {
      if (!ctx.config) {
        ctx.appendSystem("/config 暂不可用：配置向导未接入当前 REPL。");
        return;
      }
      await ctx.config.run();
      ctx.appendSystem(
        "配置已保存。当前 REPL 已启动的 provider/model 显示可能不会立刻切换；重启 REPL 后会读取新配置。",
      );
    },
  },
};

export function listSlashEntries(): { name: string; help: string }[] {
  return Object.entries(slashCommands).map(([name, e]) => ({ name, help: e.help }));
}
