export interface KeyBinding {
  id: string;                      // "palette.open"
  defaultKey: string;              // "Ctrl+P"
  description: string;             // i18n key 或字面量
  scope: "global" | "input" | "palette" | "settings";
}

export const DEFAULT_BINDINGS: KeyBinding[] = [
  { id: "palette.open",     defaultKey: "Ctrl+P",       description: "打开命令面板", scope: "global" },
  { id: "settings.open",    defaultKey: "Ctrl+,",       description: "打开设置",     scope: "global" },
  { id: "i18n.toggle",      defaultKey: "Ctrl+L",       description: "中英切换",     scope: "global" },
  { id: "help.toggle",      defaultKey: "?",            description: "切换帮助",     scope: "input" },
  { id: "focus.next",       defaultKey: "Tab",          description: "切换焦点",     scope: "global" },
  { id: "focus.prev",       defaultKey: "Shift+Tab",    description: "反向切焦",     scope: "global" },
  { id: "history.prev",     defaultKey: "Up",           description: "上条历史",     scope: "input" },
  { id: "history.next",     defaultKey: "Down",         description: "下条历史",     scope: "input" },
  { id: "abort.run",        defaultKey: "Esc",          description: "中断运行",     scope: "global" },
  { id: "exit.repl",        defaultKey: "Ctrl+C",       description: "退出（按两次）", scope: "global" },
  { id: "session.switch",   defaultKey: "Ctrl+X L",     description: "切换会话",     scope: "global" },
  { id: "session.new",      defaultKey: "Ctrl+X N",     description: "新建会话",     scope: "global" },
  { id: "session.compact",  defaultKey: "Ctrl+X C",     description: "压缩会话",     scope: "global" },
  { id: "session.timeline", defaultKey: "Ctrl+X G",     description: "会话时间线",   scope: "global" },
  { id: "session.rename",   defaultKey: "Ctrl+X R",     description: "重命名会话",   scope: "global" },
  { id: "model.switch",     defaultKey: "Ctrl+X M",     description: "切换模型",     scope: "global" },
  { id: "provider.switch",  defaultKey: "Ctrl+X P",     description: "切换服务商",   scope: "global" },
  { id: "theme.switch",     defaultKey: "Ctrl+X T",     description: "切换主题",     scope: "global" },
  { id: "editor.open",      defaultKey: "Ctrl+X E",     description: "打开外部编辑器", scope: "global" },
  { id: "message.copyLast", defaultKey: "Ctrl+X Y",     description: "复制上一条回复", scope: "global" },
  { id: "message.undo",     defaultKey: "Ctrl+X U",     description: "撤销上一轮",   scope: "global" },
  { id: "message.redo",     defaultKey: "Ctrl+X Shift+U", description: "重做上一轮", scope: "global" },
  { id: "buddy.pet",        defaultKey: "Ctrl+B",       description: "摸吉祥物",     scope: "global" },
  { id: "panel.swarm",      defaultKey: "Ctrl+X S",     description: "聚焦 swarm",   scope: "global" },
  { id: "panel.goal",       defaultKey: "Ctrl+X G",     description: "聚焦 goal",    scope: "global" },
  { id: "palette.exec",     defaultKey: "Enter",        description: "执行命令",     scope: "palette" },
  { id: "palette.close",    defaultKey: "Esc",          description: "关闭面板",     scope: "palette" },
  { id: "palette.up",       defaultKey: "Up",           description: "向上选择",     scope: "palette" },
  { id: "palette.down",     defaultKey: "Down",         description: "向下选择",     scope: "palette" },
  { id: "settings.save",    defaultKey: "Ctrl+S",       description: "保存设置",     scope: "settings" },
  { id: "settings.cancel",  defaultKey: "Esc",          description: "取消编辑",     scope: "settings" },
  { id: "settings.search",  defaultKey: "/",            description: "搜索设置",     scope: "settings" },
  { id: "settings.resetField", defaultKey: "Backspace", description: "恢复默认",     scope: "settings" },
];
