import type { PermissionMode } from "../config/index.js";
import type { CreateGoalInput, RunGoalResult } from "../goals/index.js";
import type { GoalState } from "../types/index.js";
import { goalSlashEntry } from "./slashCommands/goal.js";
import { checkpointSlashEntry } from "./slashCommands/checkpoint.js";

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
    help: "显示斜杠命令帮助浮层",
    handler: (_args, ctx) => { ctx.toggleHelp(true); },
  },

  quit: {
    help: "退出 REPL",
    handler: (_args, ctx) => { ctx.exit(); },
  },

  clear: {
    help: "清空消息列表",
    handler: (_args, ctx) => { ctx.clearMessages(); ctx.toggleHelp(false); },
  },

  mode: {
    help: "切换权限模式（default/plan/acceptEdits/auto/bypassPermissions）",
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

  mem: {
    help: "记忆操作 list/show/search（TODO step-24/25）",
    handler: (_args, ctx) => {
      ctx.appendSystem("记忆系统尚未接入（step-24/25 完成后启用）。");
    },
  },

  agents: {
    help: "列出活跃子 agent（step-22）",
    handler: (_args, ctx) => {
      const xs = ctx.listAgents();
      ctx.appendSystem(xs.length ? xs.join("\n") : "（暂无活跃子 agent）");
    },
  },

  skills: {
    help: "列出已加载技能（TODO step-29）",
    handler: (_args, ctx) => {
      const xs = ctx.listSkills();
      ctx.appendSystem(xs.length ? xs.join("\n") : "（暂无技能）");
    },
  },

  provider: {
    help: "列出已注册 provider",
    handler: (_args, ctx) => {
      ctx.appendSystem(ctx.listProviders().join(", "));
    },
  },
};

export function listSlashEntries(): { name: string; help: string }[] {
  return Object.entries(slashCommands).map(([name, e]) => ({ name, help: e.help }));
}
