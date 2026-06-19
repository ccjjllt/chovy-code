# Step 40 Acceptance

## 目标完成情况
- [x] **`Ctrl+B` / `/buddy pet`**: 触发 `PetHearts` 爱心动画，并且状态增加 `petCount`。
- [x] **`/buddy mute|unmute`**: 控制静音属性并立刻生效，持久化。
- [x] **`/buddy show|hide`**: 控制显示隐藏，并持久化到配置。
- [x] **`/buddy size`**: 支持 `auto|compact|small` 三种动态宽度策略。
- [x] **`/buddy skin`**: 支持查看、校验、切换本地皮肤 GIF 资源文件夹。
- [x] **`/buddy stats`**: 查看当前爱心统计。
- [x] **彩蛋**: `petCount > 100` 或 `> 500` 时输出特定台词。

## 接口与不变量遵守情况
- `CompanionPrefs` 新增为可选段进入 `ChovyConfig`。
- 没有依赖新 npm 包，采用 `node:events` 做进程内通信以更新 Hook。
- `pet` 动画长 2.5s（5个画面，每个500ms），正交于吉祥物工作状态。
- `CompanionHost` 内对终端列数做了限制适配，保留 `CHOVY_NO_COMPANION` 兜底检查。

## 测试验证
- `bun run typecheck` 通过。
- `bun run scripts/smoke-step40.ts` 检查了配置累加，测试通过。
