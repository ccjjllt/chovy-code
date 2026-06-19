# Step 33 — Layout primitives + 终端能力探测

**Phase**: J | **依赖**: step-05 (REPL) | **可并行**: 31, 32 | **估时**: 3h

## 目标

把后续 TUI 步骤要反复用的**布局原语**和**终端能力探测**沉淀出来：

- 布局：`Stack` / `SplitPane` / `Center` / `Constrain` / `OverlayHost`；
- 能力：宽 / 高 / 真彩色 / Unicode 宽字符 / Windows ConHost 检测。

## 产物

```
src/tui/
├── primitives/
│   ├── Stack.tsx          # 垂直堆叠 + gap
│   ├── SplitPane.tsx      # 左右双栏 + 比例
│   ├── Center.tsx         # 内容居中（计算 stringWidth + CJK 双倍宽）
│   ├── Constrain.tsx      # min/max width + height + overflow
│   └── OverlayHost.tsx    # 全屏 overlay 容器（命令面板 / 设置共用）
├── capabilities.ts        # detectTerminal()
└── stringWidth.ts         # CJK-aware 宽度（east-asian-width 简化版 ≤100 行）
```

## 实现要点

### 1. detectTerminal（启动一次，结果冻结）

```ts
// src/tui/capabilities.ts
export interface TerminalCaps {
  cols: number; rows: number;
  trueColor: boolean;       // COLORTERM=truecolor || 24bit
  unicode: boolean;         // 终端是否能正确显示 ▀▄
  isConHost: boolean;       // win32 旧 cmd.exe（无 VT）
  isWindowsTerminal: boolean;
  isFullScreenCapable: boolean;
}
export function detectTerminal(): TerminalCaps {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const colorterm = process.env["COLORTERM"] ?? "";
  const trueColor = /truecolor|24bit/i.test(colorterm);
  const isWT = !!process.env["WT_SESSION"];
  const isConHost = process.platform === "win32" && !isWT && !process.env["TERM_PROGRAM"];
  const term = process.env["TERM"] ?? "";
  const unicode = !isConHost || isWT;   // ConHost 老版可能丢字
  return { cols, rows, trueColor, unicode, isConHost, isWindowsTerminal: isWT, isFullScreenCapable: !isConHost };
}
```

调用方一次性读取，缓存到 `TerminalCapsContext`（React Context）；后续 `useTerminalCaps()` 拿。
对 stdout resize 单独提供 `useTerminalSize()` hook（订阅 `process.stdout.on("resize")`）。

### 2. SplitPane（命令面板 + 设置都用）

```tsx
<SplitPane left={<Categories/>} right={<Detail/>} ratio={0.3} minLeft={20} minRight={40} />
```

实现：用 `useTerminalSize()` 拿当前 cols → 计算 leftCols = max(minLeft, round(cols * ratio)) → `<Box width={leftCols}>` + `<Box flexGrow={1}>`。
窗口太窄（cols < minLeft + minRight）时自动堆叠垂直布局，`SplitPane` 渲染为 Stack。

### 3. OverlayHost（命令面板 / 设置共用）

```tsx
// 全屏 overlay：在 REPL 之外渲染（用 Ink 5 的 portal 模拟）
// 简化方案：repl.tsx 内 conditional render <OverlayHost>{children}</OverlayHost> 包裹整个内容
// 当任一 overlay 激活时，REPL 主体渲染前面，overlay 用 absolute-style 边框盖在上面
<OverlayHost active={paletteOpen}>
  <CommandPalette ... />
</OverlayHost>
```

Ink 不支持真正的 absolute；实现方式：overlay active 时**替换**整个 REPL render tree（保留 InputBox 输入态），加 `borderStyle="double"` 主题 `accent` 边框 + 提示行。

### 4. CJK-aware stringWidth（≤100 行）

```ts
// src/tui/stringWidth.ts
const RANGES_FULLWIDTH = [
  [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
  [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE30, 0xFE4F],
  [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
];
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue;  // control
    let full = false;
    for (const [a, b] of RANGES_FULLWIDTH) if (cp >= a && cp <= b) { full = true; break; }
    w += full ? 2 : 1;
  }
  return w;
}
```

> 故意不引 `string-width` 依赖（≈ 30KB transitive）。本实现 < 1KB 且覆盖中日韩主流。

## 接口冻结 / 不变量

- `TerminalCaps` 字段冻结；扩展只追加。
- `detectTerminal()` **启动一次**调用，结果冻结到 Context；不允许多次重算（resize 用 useTerminalSize）。
- `OverlayHost` 同时只能激活一个 overlay（命令面板 + 设置互斥）；激活态由调用方 useState 管理。

## 验收标准

- `bun run typecheck` 通过；
- 单元（`scripts/smoke-step33.ts`）：`detectTerminal()` 在 mock env 下返回正确 trueColor/isConHost；
- `stringWidth("你好abc")===7`、`stringWidth("aaa")===3`；
- 跑 chovy 在 80×24 终端：SplitPane 不裁内容；ratio=0.3 → left≈24cols；resize 到 60 cols 自动堆叠；
- OverlayHost 关闭时 REPL 不丢输入。

## 风险

- **resize 抖动**：终端 resize 期间 stdout.columns 可能瞬时为 undefined；hook 用 `?? prev` 兜底。
- **Ink 5 渲染顺序**：overlay 用替换 render tree 的方案要保证 InputBox 不卸载（保留 useState）；用 `display:none` + 条件 active 控制 overlay 显示，非 destroy。
