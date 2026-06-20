# Step 45 Acceptance

## 目标
实现「Welcome back! + 吉祥物（左栏）+ Tips（右栏）」的启动屏，在 REPL 首次渲染显示。

## 验收记录
- [x] `bun run typecheck` 通过
- [x] 启动首屏能看到 Welcome 二栏结构（通过 `smoke-step45.tsx` 验证其输出 `chovy-code v...`、欢迎语与小提示）。
- [x] 成功在 `src/cli/repl.tsx` 中集成，使用 `welcomeDismissedRef` 保证第一条用户消息后消失，并且 `/clear` 不会重显。
- [x] `CHOVY_NO_COMPANION=1` 在 `WelcomeScreen` 及 `WelcomeNarrow` 中得到兼容，关闭 GIF 显示并自适应。
- [x] 中英双语词典都在 `zh.ts` 与 `en.ts` 中等价更新，避免字典非对称错误。

该步骤完成。
