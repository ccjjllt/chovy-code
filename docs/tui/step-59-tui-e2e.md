# Step 59 — TUI E2E smoke + bench + demo 更新

**Phase**: P | **依赖**: O 全部 | **可并行**: 58 | **估时**: 2h

## 目标

把 Phase J–O 全部 smoke 接入主入口 `bun run smoke`；新增 `bun run bench:tui`；
更新既有 `bun run demo`（step-30 已落地 `scripts/demo.ts`）让它涵盖新 TUI 主线（吉祥物 / palette / theme / lang）。

## 产物

```
scripts/
├── smoke-tui.ts            # Phase J-O 30+ 步 smoke 总入口（依次跑）
├── bench-tui.ts            # 整合 step-58 perf 输出
└── demo.ts                 # 更新：新增 5 条 TUI 主线断言

package.json                # 增 "smoke:tui" / "bench:tui" 脚本
```

## 实现要点

### 1. smoke-tui.ts

```ts
// scripts/smoke-tui.ts
const STEPS = [
  "step31","step32","step33","step34","step35",   // Phase J
  "step36","step37","step38","step39","step40",   // Phase K
  "step41","step42","step43","step44",            // Phase L
  "step45","step46","step47",                     // Phase M
  "step48","step49","step50","step51","step52",   // Phase N
  "step53","step54","step55","step56","step57",   // Phase O
];

let failed = 0;
for (const id of STEPS) {
  const start = Date.now();
  try {
    await import(`./smoke-${id}.ts`);
    console.log(`✓ ${id} (${Date.now() - start}ms)`);
  } catch (err) {
    failed++;
    console.error(`✗ ${id}: ${err}`);
  }
}
if (failed > 0) { console.error(`\n${failed} smoke failed`); process.exit(1); }
```

整合进既有 `bun run smoke` 主入口（package.json 把 smoke 改成依次跑 既有 + smoke-tui.ts）。

### 2. demo.ts 更新

step-30 既有 demo 跑 5 条创新主线（ATP / SwarmR / TMT / SCW / CSG）；本步**追加** 5 条 TUI 主线：

```ts
// 6. 主题切换
const themeOut = await runChovy(["chat", "/theme set ChovyHighContrast"]);
assertMatch(themeOut, /Theme set to/i);

// 7. 语言切换
const langOut = await runChovy(["chat", "/lang en"]);
assertMatch(langOut, /Locale set to en-US/);

// 8. 命令面板（headless mode 模拟）
//    palette 是交互的，不能在 demo 里直接 trigger Ctrl+P；改为列出 palette commands：
const palOut = await runChovy(["palette", "list"]);    // step-44 加新 CLI 子命令？或：
//    更简：检查 src/palette/builtin.ts 的命令数量
assertMatch(palOut, /\d+ commands registered/);

// 9. 吉祥物（CHOVY_NO_COMPANION=0 启动后冷解码缓存生成）
//    用 Bun.spawn 设 CHOVY_HOME tmp + chovy chat "hi" + 退出 → 检查 cache 目录是否生成 frame-000.ansi
//    （fixture 用 1 帧的 mock GIF 避免真 GIF 依赖 + 解码慢）

// 10. 设置 wizard non-interactive
const cfgOut = await runChovy(["config", "--non-interactive", "--theme", "ChovyLight"]);
assertMatch(cfgOut, /theme set/i);
```

> 不在 demo 中调真 TUI overlay（需要 stdin/tty）；改用对应 CLI 子命令或文件断言。

### 3. bench-tui.ts

```ts
// scripts/bench-tui.ts
import { runBenchmarks } from "./perf-tui.ts";
const result = await runBenchmarks(/* 全部 */);
console.log(JSON.stringify(result, null, 2));
// WARN 输出但不阻断 demo（step-30 既有 bench 同纪律）
```

`bun run bench:tui` 不进 CI 必跑（性能噪声大），开发者手动跑。

### 4. package.json 脚本

```json
{
  "scripts": {
    "smoke": "bun scripts/smoke.ts && bun scripts/smoke-tui.ts",
    "smoke:tui": "bun scripts/smoke-tui.ts",
    "bench:tui": "bun scripts/bench-tui.ts",
    "demo": "bun scripts/demo.ts"
  }
}
```

`smoke:tui` 是子集；`smoke` 跑全部（既有 + TUI）。

### 5. CI 集成

GitHub Actions matrix（如果有 CI）：

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
steps:
  - run: bun install
  - run: bun run typecheck
  - run: bun run smoke
  - run: bun run demo
  - run: bun run build && bun bin/chovy.js --version
```

Windows runner 跑 smoke + demo 验证 ConHost / WT 兼容（demo 内已检测）。

### 6. mock GIF fixture

为了让 smoke-step36/37 不依赖真 GIF 解码慢：

```
tests/fixtures/companion/
├── mock-1frame.gif      # 1 帧 16x16 纯色（手写 GIF 二进制 ~200B）
└── mock-3frame.gif      # 3 帧 16x16
```

smoke 用 mock 而非 `gif/2026-06-12_*.GIF`；保留生产 GIF 给真实运行用。

## 接口冻结 / 不变量

- 所有 smoke 必须 ≤ 5s 单文件 + 30s 总时长，避免 CI 超时；
- demo 的 5 条 TUI 主线不依赖网络 / stdin；用 CHOVY_E2E_USE_MOCK=1（既有）；
- bench 输出 JSON 不阻断 CI（WARN-only）；性能 fail 仅 bench-tui.ts 顶层判定，不在 demo 里。

## 验收标准

- `bun run smoke` 退出码 0，包含 Phase J-O 全部 smoke；
- `bun run smoke:tui` 单跑通过；
- `bun run demo` 退出码 0，含 10 条主线（既有 5 + 新 5）；
- `bun run bench:tui` 输出 JSON，所有 step-58 基线在上限内；
- Windows runner CI 通过（如有）。

## 风险

- **smoke-tui 总时长**：30 个 smoke × 5s = 150s 太长 → 并行跑（Bun.spawn 并发 ≤ 5）；total 应 ≤ 30s；
- **mock GIF 解码差异**：mock 用单帧避免 LZW 复杂；但 step-36 自实现要兼容多帧 → 至少有 mock-3frame；
- **demo Windows 路径**：不要写死正斜杠；用 path.join 跨平台；step-30 demo 已是 ts script 不依赖 shell。
