# Step 58 — Windows ConHost 兼容 + 性能压测

**Phase**: P | **依赖**: O 全部 | **可并行**: 59 | **估时**: 3h

## 目标

把 TUI 第二阶段所有新增模块在 **Windows ConHost** + **Windows Terminal** + **Linux/macOS terminal** 上跑通；
建立性能基线（启动 / 帧切换 / 焦点切换 / palette 搜索 / settings 打开）；超出基线时报警。

## 产物

```
scripts/
├── perf-tui.ts                 # 性能 bench（输出指标 JSON）
└── windows-compat-check.ts     # ConHost / WT 检测 + 兼容回退建议

docs/tui/
└── known-limitations.md         # 本阶段汇总的 KNOWN-LIMITATIONS（最终合并到 docs/KNOWN-LIMITATIONS.md）
```

## 实现要点

### 1. ConHost 闪烁兜底

汇总各 step 已有的 env 开关：

| 开关 | 影响 | 默认 |
|---|---|---|
| `CHOVY_NO_SWARM_PANEL` | 禁用 SwarmPanel + GoalPanel | 0 |
| `CHOVY_NO_COMPANION` | 禁用吉祥物 | 0 |
| `CHOVY_NO_PALETTE` | Ctrl+P 走 inline fallback | 0 |
| `CHOVY_NO_TUI` | 顶层兜底，整个新 TUI 退化到 step-30 形态 | 0 |
| `CHOVY_NO_ANIM` | 禁用动画 | 0 |

`CHOVY_NO_TUI=1` 是**新加的顶层**：repl.tsx 顶部 `if (env) { return <LegacyRepl/>; }`，
LegacyRepl 是 step-30 形态最简版（只 HeaderBar + MessageList + InputBox），无 companion / palette / settings。

### 2. ConHost 自动检测建议

启动时若检测到 `process.platform === "win32" && !process.env["WT_SESSION"] && !process.env["TERM_PROGRAM"]` →
首屏 toast.warning 提示：

```
⚠ 检测到 Windows ConHost。建议改用 Windows Terminal 获得最佳显示。
   不影响功能；如有闪烁可设 CHOVY_NO_SWARM_PANEL=1。
```

只提示一次（写到 onboarding.json 的 `conhostWarnedAt` 字段）。

### 3. 性能基线（perf-tui.ts）

| 指标 | 基线 | 上限（fail） |
|---|---|---|
| 冷启动到首屏（首次解码 GIF）| ≤ 800ms | 1500ms |
| 热启动到首屏（缓存命中）    | ≤ 200ms | 400ms |
| Ctrl+P → palette 可见     | ≤ 80ms  | 200ms |
| palette 50 项搜索 1 次    | ≤ 50ms  | 150ms |
| Ctrl+, → settings 可见   | ≤ 100ms | 250ms |
| Tab 焦点切换              | ≤ 16ms  | 50ms |
| 100 条 messages 渲染     | ≤ 50ms  | 150ms |
| /theme set X 切主题      | ≤ 80ms  | 200ms |
| /lang en 切语言          | ≤ 80ms  | 200ms |
| 内存占用（启动后空闲）    | ≤ 80MB  | 150MB |

bench 跑 5 次取均值；任一基线超 fail 上限 → 退出码 1。

```ts
// scripts/perf-tui.ts
const RESULTS = await runBenchmarks([
  { id: "cold-start", run: coldStart },
  { id: "hot-start", run: hotStart },
  { id: "palette-open", run: paletteOpen },
  // ...
]);
const failed = RESULTS.filter(r => r.avgMs > LIMITS[r.id]);
if (failed.length > 0) {
  console.error("PERF FAIL:", failed);
  process.exit(1);
}
console.log(JSON.stringify(RESULTS, null, 2));
```

### 4. 兼容性矩阵

| 终端 | 真彩色 | Unicode 半块 | 动画 | 闪烁风险 |
|---|---|---|---|---|
| Windows Terminal      | ✅ | ✅ | ✅ | 低 |
| Windows ConHost (新)  | ⚠ 部分 | ✅ | ⚠ | 中 |
| Windows ConHost (旧)  | ❌ | ⚠ | ❌ | 高 — 推荐 CHOVY_NO_TUI |
| macOS Terminal.app    | ✅ | ✅ | ✅ | 低 |
| iTerm2                | ✅ | ✅ | ✅ | 低 |
| GNOME Terminal        | ✅ | ✅ | ✅ | 低 |
| Alacritty / Kitty     | ✅ | ✅ | ✅ | 低 |
| WSL ConHost           | 同 ConHost | | | |
| SSH（pty 转发）       | 取决于 client | | | |

### 5. 内存 / 资源回收审计

启动 chovy → 跑 5 分钟 → kill → 检查：

- ANSI 帧缓存目录大小 < 5MB（5 GIF × <1MB）；
- 没有遗留子进程（goal / SwarmR）；
- 没有 telemetry 文件无限增长（既有 §3 已限制）。

### 6. windows-compat-check.ts

可执行脚本（`bun run scripts/windows-compat-check.ts`）：

```ts
const caps = detectTerminal();
console.log({
  platform: process.platform,
  isWT: caps.isWindowsTerminal,
  isConHost: caps.isConHost,
  trueColor: caps.trueColor,
  unicode: caps.unicode,
});
if (caps.isConHost && !caps.trueColor) {
  console.log("\n建议设置以下环境变量获得最佳体验：");
  console.log("  set CHOVY_NO_ANIM=1");
  console.log("  set CHOVY_NO_SWARM_PANEL=1");
}
```

写到 USAGE.md 作为「我用 cmd.exe 怎么办？」FAQ 的对应工具。

## 接口冻结 / 不变量

- `CHOVY_NO_TUI=1` 是**最终兜底**：必须能让 chovy-code TUI 阶段所有功能退化到 step-30 行为，
  保证既有用户**永远**有 escape hatch；
- 性能基线写在 `scripts/perf-tui.ts` 常量；调整必须 PR 评审说明；
- ConHost 警告 toast 一次性（onboarding.json 记录），不重复打扰。

## 验收标准

- `bun run scripts/perf-tui.ts` 全部基线 < 上限；
- `bun run scripts/windows-compat-check.ts` 在 Windows Terminal 输出 trueColor=true，在 ConHost 输出 fallback 建议；
- `CHOVY_NO_TUI=1 chovy chat "hi"` 正常工作，外观回到 step-30 形态；
- 5 分钟空闲后内存 ≤ 100MB；
- 启动到首屏 ≤ 800ms（冷）/ 200ms（热）。

## 风险

- **bench 噪声**：CI 环境 CPU 抖动 → 5 次取中位 + 上限留 ~80% buffer；
- **WSL 环境识别**：`process.platform === "linux"` 但实际跑在 WSL → ConHost 行为；用 `/proc/version` 关键字探测 WSL，提示与 ConHost 同。
- **bench 跑不动**：某些 ConHost 测不出真实首屏时间（无 ESC 序列回显）→ headless 模式下用 process.stdout.write 计时近似。
