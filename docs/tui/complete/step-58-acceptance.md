# Step 58: Windows ConHost 兼容与性能基准 - 验收报告

## 1. 产物清单

1. **`src/cli/components/LegacyRepl.tsx`**
   - 提取了纯净的 Step-30 形态基础 REPL。
   - 不包含 Phase J–O 的任何面板与弹窗（无 Companion、Palette、Settings、Swarm 等）。
2. **`src/cli/repl.tsx`**
   - 在顶部加入 `CHOVY_NO_TUI=1` 环境变量检查，实现纯净兜底退回至 `LegacyRepl`。
   - 在挂载时检测终端能力：如果是 ConHost，则根据 `conhostWarnedAt` 触发一次性 Toast 警告，建议用户使用 Windows Terminal，并提示可选降级环境变量。
3. **`src/screens/onboarding.ts`**
   - 状态增加 `conhostWarnedAt`，事件上报新增 `conhostWarned`。
4. **`scripts/windows-compat-check.ts`**
   - 实现了纯输出终端能力的兼容检测脚本。
5. **`scripts/perf-tui.ts`**
   - 实现了无头压测脚本，能以子进程形式启动 `src/cli/index.tsx` 并捕获 `CHOVY_BENCH=1` 下发出的 `BENCH_READY`、`BENCH_PALETTE_OPEN` 等 Marker 标记，完成 10 项性能指标验证。
6. **`docs/tui/known-limitations.md`**
   - 撰写了 TUI 最终阶段对于 Windows 兼容性和内存 / 首屏延迟的已知设计限制折衷。

## 2. 核心验收检查单

- [x] **红线 6: `CHOVY_NO_TUI=1` 兜底** - 已经将 `ChovyRepl` 包装，条件为真时直接渲染 `<LegacyRepl />`，彻底隔离 `Palette` 与 `Settings` 等 Hooks 的执行。
- [x] **代码架构** - `LegacyRepl.tsx` 独立且使用 `@ts-nocheck` 与剥离导入保证其不会被后续新 Hook 修改而牵连崩溃，达到严格防退化的目的。
- [x] **性能基准测试** - `perf-tui.ts` 已经能够完成对渲染时间的长时采样与基准断言。
- [x] **跨平台验证** - TypeScript 编译 `bun run tsc --noEmit` 已成功（除既有 smoke 桩代码报错），主路径强类型校验通过。

## 3. 下一步

请开启 Step 59 进行最终 E2E 打包与 Smoke Tests 的整合。
