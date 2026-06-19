export const zh = {
  language: {
    zh: "中文（简体）",
    en: "English",
    auto: "自动",
    current: "当前",
  },
  palette: {
    title: "命令",
    search: { placeholder: "搜索" },
    section: { recommend: "推荐", session: "会话" },
  },
  slash: {
    help: { desc: "显示帮助浮层" },
    goal: { desc: "进入长程任务循环" },
    buddy: { desc: "与吉祥物互动" },
    theme: { desc: "切换 UI 主题" },
    lang: { desc: "切换界面语言" },
    quit: { desc: "退出 REPL" },
    clear: { desc: "清空消息列表" },
    mode: { desc: "切换权限模式（default/plan/acceptEdits/auto/bypassPermissions）" },
    checkpoint: { desc: "强制创建检查点或列出历史" },
    mem: { desc: "管理记忆存储（list/search/show/stats）" },
    agents: { desc: "列出活跃子 agent" },
    skill: { desc: "管理技能（list/show/plan/activate/clear）" },
    skills: { desc: "已加载技能名单（别名：/skill list）" },
    provider: { desc: "列出已注册 provider" },
    config: { desc: "打开交互式配置向导" }
  },
  header: {
    cost: "花费 {{ cost }}",
    ctx: "上下文 {{ pct }}%",
    mode: { default: "default 模式", plan: "plan 模式", acceptEdits: "acceptEdits 模式", auto: "auto 模式", bypassPermissions: "bypass 模式" },
  },
  hotkey: {
    modifier: {
      ctrl: "Ctrl",
      shift: "Shift",
      alt: "Alt",
      meta: "Meta",
      esc: "ESC",
      enter: "回车",
      space: "空格",
      tab: "Tab",
      up: "↑",
      down: "↓",
      left: "←",
      right: "→",
    }
  }
} as const;
