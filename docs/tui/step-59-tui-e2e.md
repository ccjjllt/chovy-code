# Step 59 — TUI E2E smoke + bench + demo 更新

**Phase**: P | **依赖**: O 全部 | **可并行**: 58 | **估时**: 2h

> ⚠ **评审注记（2026-06-20，已实跑验证 · 详见 `review-claude-code-alignment.md §1`）**：
> 1. **本步假设的绿色基线现在是红的**：`bun run demo` 当前在 `main` 上失败——`scripts/demo.ts:45`
>    断言 `/8 passed, 0 failed/`，但 `smoke.ts` 现有 11 case + 1 bin = **12 项**，实跑输出 `12 passed, 0 failed`，
>    demo 第 3 步正则不匹配 → 退出码 1。本步「在既有 5 条 demo 主线上追加 5 条」之前，**必须先修这条**：
>    把 demo 对 smoke 的断言改成**数量无关**（`/\d+ passed, 0 failed/` + 退出码 0），否则每加一个 smoke case 都会再次打红。
> 2. **覆盖率载体不要新增 CLI 子命令**：下文 `palette list` / `palette coverage --json` 今天不存在，且会新增 CLI surface，
>    与红线 #14「`bin/chovy.js` 字节级一致」冲突。改用 smoke 内部只读 API（直接 import `getCommandCoverage()` 计数）。
> 3. **`smoke-tui.ts` 的 import-即-跑模式脆弱**：靠 import 副作用执行 → 无法重复跑、27 个 spawn 串行触发文档自己警告的 150s 超时、
>    `exit()` vs `throw` 判定不一致。改为每个 `smoke-stepXX.ts` 导出 `run(): Promise<Result>`，聚合器并发（≤5）调度收集。
> 4. **smoke 仍不覆盖渲染**：见 architecture §7 评审注记；本步的 TUI E2E 必须明确是"纯逻辑单测 + 子进程抽查"，
>    不要声称验证了交互渲染。

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
assertMatch(langOut, /Locale set to en/);

// 8. 命令面板（headless mode 模拟）
//    palette 是交互的，不能在 demo 里直接 trigger Ctrl+P；改为列出 palette commands：
const palOut = await runChovy(["palette", "list"]);    // step-44 加新 CLI 子命令？或：
assertMatch(palOut, /commandEquivalents:\s*(7[2-9]|[8-9]\d|\d{3,})/);

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

### 4. command / skill 覆盖审计

Step-59 不能只信 step-43/44 的局部 smoke；必须在最终集成状态重新审计 `docs/tui/command-skill-coverage.md` 的门槛：

```ts
// scripts/smoke-tui.ts 里的 Phase P 汇总段
const coverage = await runChovyJson(["palette", "coverage", "--json"]);
assert(coverage.commandEquivalents >= 72);
assert(coverage.bundledSkills >= 15);
assert(coverage.sources.includes("slash"));
assert(coverage.sources.includes("settings"));
assert(coverage.sources.includes("skill"));
assert(coverage.nonCounted.every((x) => x.reason !== "todo"));
```

覆盖报告至少包含：

- `commandEquivalents`：只统计当前构建 visible 且有实际行为的命令；
- `byGroup`：对应 coverage 文档 8 个 group，每组列出 visible / hidden / unavailable；
- `bySource`：`slash` / `settings` / `skill` / `plugin` / `workflow` / `mcp`；
- `bundledSkills`：现有 7 个 + 新增 skill 的实际注册数量；
- `nonCounted`：列出 hidden、disabled、feature-gated、TODO、backend missing 的条目和原因。

如果命令或 skill 数量达标但 `nonCounted` 中出现 “coming soon” 被误计、无 `run` / `prefill` / `settings jump` 行为的条目，smoke 必须失败。

### 5. package.json 脚本

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

### 6. CI 集成

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

### 7. mock GIF fixture

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
- `palette coverage --json` 或等价 smoke 输出证明 `commandEquivalents >= 72`、`bundledSkills >= 15`，且 hidden/disabled/TODO/backend-missing 不被计数；
- `/skills`、Ctrl+P `Skills` 分类、`chovy skill list` 三处 skill 数量一致；
- Windows runner CI 通过（如有）。

## 风险

- **smoke-tui 总时长**：30 个 smoke × 5s = 150s 太长 → 并行跑（Bun.spawn 并发 ≤ 5）；total 应 ≤ 30s；
- **mock GIF 解码差异**：mock 用单帧避免 LZW 复杂；但 step-36 自实现要兼容多帧 → 至少有 mock-3frame；
- **demo Windows 路径**：不要写死正斜杠；用 path.join 跨平台；step-30 demo 已是 ts script 不依赖 shell。
