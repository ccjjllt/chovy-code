# Step 34 (TUI 按键绑定注册系统) 完成报告

## 检查清单
- [x] 在 `src/config/config.ts` 中实现了 `keybindings: Record<string, string | null>` 的配置 Schema 扩展。
- [x] 在 `src/keybindings/index.ts` 与 `src/keybindings/defaults.ts` 中实现了中心化按键绑定注册表，以及代表超过 35 个默认操作的 `DEFAULT_BINDINGS`。
- [x] 在 `src/keybindings/parse.ts` 中实现了热键/双击(chord)序列解析器与匹配器，并加入了防止将 `Esc` 键用作双击按键首位的防护机制。
- [x] 在 `src/keybindings/persist.ts` 中创建了配置持久化接口，用于代理并写入按键绑定设置的调整。
- [x] 在 `src/keybindings/conflict.ts` 中实现了冲突检测机制，能够按 `scope` 范围（或全局冲突）将重复的按键绑定进行分组。
- [x] 在 `src/keybindings/useKeybinding.ts` 中创建了 React Hook `useKeybinding`，用于监听匹配的快捷键，安全地检查 `isTTY`，并管理 200ms 的 chord 判定窗口状态。
- [x] 执行 `bun run typecheck` 成功通过。
- [x] 执行 `scripts/smoke-step34.ts` 中的模拟单元测试成功通过。

Step 34 的所有要求已全部成功达成。
