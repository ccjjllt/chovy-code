# Step 34 — Keybinding 注册中心

**Phase**: J | **依赖**: step-33 (layout) | **可并行**: 35 | **估时**: 4h

## 目标

把所有 TUI 快捷键集中到一处管理。提供：

- 默认键位表（`Ctrl+P` 命令面板 / `Ctrl+,` 设置 / `Ctrl+L` 切换语言 / MiMo 式 `Ctrl+X` leader / `Tab` 焦点环 / ...）；
- 用户在 `config.json` 覆盖；
- `useKeybinding(id, handler)` hook；
- 冲突检测（同 key 多 binding 警告）。

## 产物

```
src/keybindings/
├── index.ts           # KeyBinding / getBinding / registerBinding / setUserBinding
├── defaults.ts        # 默认键位表（≥ 35 条）
├── parse.ts           # "Ctrl+Shift+P" / "Ctrl+X L" → KeyMatcher
├── persist.ts         # config.json 写入 / 读取
├── conflict.ts        # 冲突检测（同 key 不同 id）
└── useKeybinding.ts   # React hook：在挂载范围内监听
```

## 实现要点

### 1. KeyBinding 接口（B8 冻结）

```ts
// src/keybindings/index.ts
export interface KeyBinding {
  id: string;                      // "palette.open"
  defaultKey: string;              // "Ctrl+P"
  description: string;             // i18n key 或字面量
  scope: "global" | "input" | "palette" | "settings";
  // 扩展只追加可选字段
}
```

`scope` 决定 hook 在哪些焦点状态下生效：

- `global`：始终激活；
- `input`：仅 InputBox 聚焦时；
- `palette` / `settings`：仅对应 overlay 打开时。

### 2. 默认键位表

```ts
// src/keybindings/defaults.ts
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
```

`Ctrl+P` / `Ctrl+,` / `Ctrl+L` 是红线键位，不因参考 MiMo/cc-haha 改名；其它 `Ctrl+X <key>` 作为 leader 体系，优先覆盖 session/model/provider/theme/editor/message 操作。

### 3. parse.ts — 字符串 → matcher

```ts
// "Ctrl+P" / "Ctrl+Shift+P" / "Ctrl+X L" (chord)
export interface KeyMatcher {
  modifiers: { ctrl: boolean; shift: boolean; meta: boolean };
  primary: string;        // "p" / "Tab" / "Enter" / "Up"
  chord?: string;         // 第二段（"L"），仅 Ctrl+X L 这类双键
}
export function parseKey(s: string): KeyMatcher;
export function matchInkKey(matcher: KeyMatcher, input: string, key: Ink.Key, chordState: string|null): { match: boolean; chordPending: boolean };
```

**chord 处理**：检测到 chord head（`Ctrl+X`）后开 200ms 窗口等第二键；窗口内不匹配则当作普通输入。
chord state 由 REPL 顶层 useRef 持有，传给所有 useKeybinding hook。

### 4. useKeybinding hook

```ts
// src/keybindings/useKeybinding.ts
export function useKeybinding(
  id: string,
  handler: () => void,
  opts?: { isActive?: boolean }
): void {
  const matcher = useMemo(() => parseKey(getBinding(id)), [id]);
  useInput((input, key) => {
    if (opts?.isActive === false) return;
    const r = matchInkKey(matcher, input, key, chordState.current);
    if (r.chordPending) { chordState.current = matcher.primary; return; }
    if (r.match) { chordState.current = null; handler(); }
  }, { isActive: opts?.isActive });
}
```

### 5. 冲突检测

```ts
// 启动时跑一次 + 每次 setUserBinding 后跑一次
export function detectConflicts(bindings: KeyBinding[], userOverride: Record<string, string|null>): Array<{ key: string; ids: string[]; scope: string }> {
  // 同 scope（或 global+其它）下 key 冲突 → 收集
  // 输出形如 [{ key: "Ctrl+P", ids: ["palette.open", "user.thing"], scope: "global" }]
}
```

冲突在启动 telemetry warn 一次（非致命），用户可在设置界面看到 ⚠ 标记（step-51）。

### 6. 持久化

```json
// config.json
{
  "keybindings": {
    "palette.open": "Ctrl+P",        // 默认值，可省略
    "buddy.pet": null                  // null = 取消该绑定
  }
}
```

## 接口冻结 / 不变量

- `KeyBinding` 接口冻结（B8）；scope 联合扩展只追加。
- `getBinding(id)` 返回最终 key（user override > default）；id 不存在抛 `INTERNAL`。
- chord 窗口 200ms 写在 const，**不**进 config（避免用户调小到 50ms 误触）。
- 冲突检测 warn 但**不**自动解决；UI 用 step-51 settings 让用户改。

## 验收标准

- `bun run typecheck` 通过；
- 单元（`scripts/smoke-step34.ts`）：`parseKey("Ctrl+Shift+P").modifiers.shift===true`；`matchInkKey` 在 mock Ink key 下返回 match；
- chord：发 `Ctrl+X` 后 100ms 内 `L` 触发 `session.switch`；300ms 后 `L` 不触发；
- chovy REPL 跑 `Ctrl+P` 触发 palette.open（step-41 之后才有真实 handler；本步只验证 hook 调用）；
- 冲突检测：把两条 binding 设成同 key → 启动 warn 包含两 id。

## 风险

- **Ink 5 的 useInput 在 raw mode 失效**：非 TTY 下 `useInput` 的 `isActive` 必须是 false，否则 process 卡住。`useKeybinding` 自动检测 `process.stdin.isTTY`。
- **chord 与 Esc 冲突**：Esc 单按和 Esc 作为 chord 第一键的歧义 → chovy-code 不支持 Esc 作 chord 头；在 `parseKey` 抛错。
- **Windows Ctrl+逗号**：部分终端把 `Ctrl+,` 吞掉；KNOWN-LIMITATIONS 注明 Windows Terminal 自带不影响，老 ConHost 用户可改 `Ctrl+;`。
