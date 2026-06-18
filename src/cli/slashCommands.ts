import type { PermissionMode } from "../config/index.js";

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

  goal: {
    help: "设置 / 查看长程目标（占位，TODO step-23）",
    handler: (args, ctx) => {
      const v = args.trim();
      if (!v) { ctx.appendSystem("当前未设置 /goal（goal 循环将于 step-23 接入）。"); return; }
      ctx.setGoal(v);
      ctx.appendSystem(`已记录目标：${v}（仅占位，循环执行待 step-23）`);
    },
  },

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
