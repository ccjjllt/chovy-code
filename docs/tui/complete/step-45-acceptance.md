# Step 45 Acceptance

## 目标
实现「Welcome back! + 吉祥物（左栏）+ Tips（右栏）」的启动屏，在 REPL 首次渲染且仅有一条系统消息时显示。

## 验收记录
- [x] `bun run typecheck` 通过，无编译错误。
- [x] 启动首屏能看到 Welcome 二栏结构（通过 `smoke-step45.tsx` 验证其输出 `chovy-code v...`、欢迎语与小提示）。
- [x] 成功在 `src/cli/repl.tsx` 中集成，使用 `welcomeDismissedRef` 保证第一条用户输入或系统回复后永久消失，并且 `/clear` 不会造成重新显示。
- [x] `CHOVY_NO_COMPANION=1` 在 `WelcomeScreen` 及 `WelcomeNarrow` 中得到兼容，彻底隐藏 GIF 并将 Tips 区扩展自适应。
- [x] 窗体小于 80 字符时，能够使用 `WelcomeNarrow` 正常降级。
- [x] 中英双语词典都在 `zh.ts` 与 `en.ts` 中等价更新，已包含问候和 tips 等所有相关字段，避免了字典非对称错误。

该步骤开发及验证完成。
