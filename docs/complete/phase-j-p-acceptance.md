# Phase J–P 总验收

## 范围

step-31 ~ step-60，TUI 第二阶段全部产物。

## 验收命令

- `bun run typecheck`
- `bun run smoke`（含 smoke-tui 30+ 步）
- `bun run demo`（含 5 条新 TUI 主线）
- `bun run bench:tui`（性能基线）

## 检查清单

- [x] 5 项 TUI 创新已落地（吉祥物 / 命令面板 / 紫蓝主题 / 中英 i18n / 流畅度三件套）
- [x] 6 个新模块（theme / i18n / keybindings / tui / companion / palette）依赖图无环
- [x] Welcome / Settings 两个屏幕与 7 类设置域实现完整
- [x] Command / slash / skills 覆盖矩阵达标：`commandEquivalents >= 72`、bundled skills ≥15，覆盖报告含 `byGroup` / `bySource` / `nonCounted`
- [x] 15 个 bundled skills 均保留 CSG metadata：`requires` / `provides` / `conflicts` / `budgetTokens`，且三入口数量一致
- [x] B8 / B9 / B10 接口冻结，字段名不改
- [x] Windows ConHost / Windows Terminal / Linux / macOS 都能跑
- [x] CHOVY_NO_TUI=1 退化到 step-30 行为
- [x] AGENTS.md TUI 不变量已纳入，且只包含 phase 级验收导航
- [x] USAGE / DEVELOPING / KNOWN-LIMITATIONS 已更新
- [x] phase-j-acceptance.md 等子阶段验收引用就位
