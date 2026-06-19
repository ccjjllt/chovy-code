export const en = {
  language: {
    zh: "Chinese (Simplified)",
    en: "English",
    auto: "Auto",
    current: "Current",
  },
  palette: {
    title: "Commands",
    search: { placeholder: "Search" },
    section: { recommend: "Recommended", session: "Session" },
  },
  slash: {
    help: { desc: "Show help overlay" },
    goal: { desc: "Start a long-horizon goal loop" },
    buddy: { desc: "Interact with companion" },
    theme: { desc: "Switch UI theme" },
    lang: { desc: "Switch interface language" },
    quit: { desc: "Quit REPL" },
    clear: { desc: "Clear message list" },
    mode: { desc: "Switch permission mode (default/plan/acceptEdits/auto/bypassPermissions)" },
    checkpoint: { desc: "Force a checkpoint or list past checkpoints" },
    mem: { desc: "Manage memory store (list/search/show/stats)" },
    agents: { desc: "List active sub-agents" },
    skill: { desc: "Manage skills (list/show/plan/activate/clear)" },
    skills: { desc: "List loaded skills (alias for /skill list)" },
    provider: { desc: "List registered providers" },
    config: { desc: "Open interactive configuration wizard" }
  },
  header: {
    cost: "Cost {{ cost }}",
    ctx: "Context {{ pct }}%",
    mode: { default: "default mode", plan: "plan mode", acceptEdits: "acceptEdits mode", auto: "auto mode", bypassPermissions: "bypass mode" },
  },
  hotkey: {
    modifier: {
      ctrl: "Ctrl",
      shift: "Shift",
      alt: "Alt",
      meta: "Meta",
      esc: "ESC",
      enter: "Enter",
      space: "Space",
      tab: "Tab",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
    }
  },
  welcome: {
    greet: "Welcome back!",
    whatsnew: "What's new",
    releasenotes: "/release-notes to view more",
    tips: {
      title: "Tips",
      init: "Run /init to initialize chovy.md",
      palette: "• Ctrl+P to open Command Palette",
      settings: "• Ctrl+, to open Settings",
      lang: "• Ctrl+L to switch language",
      buddy: "• /buddy to interact with companion",
      goal: "• /goal to start long-running task"
    }
  }
} as const;
