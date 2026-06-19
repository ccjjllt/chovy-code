import { registerCommand } from "./registry.js";
import type { ReplCtx } from "../cli/slashCommands.js";

export function registerBuiltinPaletteCommands(): void {
  const dummyCommands = [
    // Session / Transcript
    { id: "session.new", name: "new", cat: "session", desc: "New session", hidden: true },
    { id: "session.list", name: "sessions", cat: "session", desc: "List sessions", hidden: true },
    { id: "session.resume", name: "resume", cat: "session", desc: "Resume session", hidden: true },
    { id: "session.rename", name: "rename", cat: "session", desc: "Rename session", hidden: true },
    { id: "session.compact", name: "compact", cat: "session", desc: "Compact session", hidden: true },
    { id: "session.copy", name: "copy", cat: "session", desc: "Copy session", hidden: true },
    { id: "session.export", name: "export", cat: "session", desc: "Export session", hidden: true },
    { id: "session.clear", name: "clear", cat: "session", desc: "Clear session", hidden: true },
    { id: "session.quit", name: "quit", cat: "session", desc: "Quit REPL", hidden: true },
    { id: "session.rewind", name: "rewind", cat: "session", desc: "Rewind session", hidden: true },
    { id: "session.timeline", name: "timeline", cat: "session", desc: "Session timeline", hidden: true },
    { id: "session.branch", name: "branch", cat: "session", desc: "Branch session", hidden: true },
    { id: "session.diff", name: "diff", cat: "session", desc: "Diff session", hidden: true },

    // Prompt / Input
    { id: "prompt.editor", name: "editor", cat: "prompt", desc: "Toggle editor mode" },
    { id: "prompt.paste", name: "paste", cat: "prompt", desc: "Paste clipboard" },
    { id: "prompt.undo", name: "undo", cat: "prompt", desc: "Undo typing" },
    { id: "prompt.redo", name: "redo", cat: "prompt", desc: "Redo typing" },
    { id: "prompt.thinking", name: "thinking", cat: "prompt", desc: "Toggle thinking output" },
    { id: "prompt.tool_details", name: "tool-details", cat: "prompt", desc: "Toggle tool details" },
    { id: "prompt.timestamps", name: "timestamps", cat: "prompt", desc: "Toggle timestamps" },
    { id: "prompt.vim", name: "vim", cat: "prompt", desc: "Toggle vim mode" },

    // Provider / Model
    { id: "model.providers", name: "providers", cat: "provider", desc: "List providers" },
    { id: "model.models", name: "models", cat: "model", desc: "List models" },
    { id: "model.usage", name: "usage", cat: "model", desc: "Show usage" },
    { id: "model.cost", name: "cost", cat: "model", desc: "Show cost" },
    { id: "model.extra_usage", name: "extra-usage", cat: "model", desc: "Show extra usage" },

    // Config / Settings
    { id: "config.themes", name: "themes", cat: "settings", desc: "List themes" },
    { id: "config.color", name: "color", cat: "settings", desc: "Change color" },
    { id: "config.language", name: "language", cat: "settings", desc: "Change language" },

    // Agents / Goals / Memory
    { id: "agent.tasks", name: "tasks", cat: "goal", desc: "List tasks" },
    { id: "agent.workflows", name: "workflows", cat: "goal", desc: "List workflows" },
    { id: "agent.plan", name: "plan", cat: "goal", desc: "Show plan" },
    { id: "agent.context", name: "context", cat: "memory", desc: "Show context" },
    { id: "agent.stats", name: "stats", cat: "memory", desc: "Show stats" },

    // Skills / Plugins / MCP
    { id: "skill.doctor", name: "skill-doctor", cat: "skills", desc: "Run skill doctor" },
    { id: "skill.create", name: "skill-create", cat: "skills", desc: "Create a skill" },
    { id: "plugin.list", name: "plugin", cat: "tools", desc: "List plugins" },
    { id: "plugin.files", name: "files", cat: "external", desc: "List files" },
    { id: "plugin.add_dir", name: "add-dir", cat: "external", desc: "Add directory" },
    { id: "plugin.init", name: "init", cat: "external", desc: "Initialize workspace" },

    // Diagnostics / Review
    { id: "diag.status", name: "status", cat: "diagnostics", desc: "Show status" },
    { id: "diag.doctor", name: "doctor", cat: "diagnostics", desc: "Run doctor" },
    { id: "diag.release_notes", name: "release-notes", cat: "diagnostics", desc: "Show release notes" },
    { id: "diag.upgrade", name: "upgrade", cat: "diagnostics", desc: "Upgrade app" },
    { id: "diag.review", name: "review", cat: "diagnostics", desc: "Code review" },
    { id: "diag.ultrareview", name: "ultrareview", cat: "diagnostics", desc: "Ultra review" },
    { id: "diag.security", name: "security-review", cat: "diagnostics", desc: "Security review" },
    { id: "diag.pr", name: "pr-comments", cat: "diagnostics", desc: "PR comments" },
    { id: "diag.feedback", name: "feedback", cat: "diagnostics", desc: "Send feedback" },
    { id: "diag.heap", name: "heap-dump", cat: "diagnostics", desc: "Heap dump" },
    { id: "diag.setup", name: "terminal-setup", cat: "diagnostics", desc: "Terminal setup" },
    { id: "diag.github", name: "install-github-app", cat: "diagnostics", desc: "Install GitHub App" },
    { id: "diag.slack", name: "install-slack-app", cat: "diagnostics", desc: "Install Slack App" },

    // Companion
    { id: "buddy.background", name: "background", cat: "companion", desc: "Toggle background" },
    { id: "buddy.logo", name: "logo", cat: "companion", desc: "Toggle logo" },
    { id: "buddy.debug", name: "debug", cat: "companion", desc: "Toggle buddy debug" },
  ];

  for (const cmd of dummyCommands) {
    try {
      registerCommand({
        id: cmd.id,
        label: () => cmd.desc,
        description: () => cmd.desc,
        category: cmd.cat as any,
        run: (ctx: ReplCtx) => ctx.appendSystem(`Ran ${cmd.name}`),
        slash: { name: cmd.name },
        source: "builtin",
        direct: true,
        hidden: (cmd as any).hidden,
        enabled: (cmd as any).hidden ? false : true,
      });
    } catch {}
  }
}
