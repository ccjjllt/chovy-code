# Step 31 — TUI 主题系统（紫蓝默认 + 自定义 + 持久化）

**Phase**: J | **依赖**: step-02 (config) | **可并行**: 32, 33 | **估时**: 4h | **创新**: THEME-VB

## 目标

把所有 TUI 颜色 / 边框 / spinner 字符**集中到一个主题对象**里。默认 `ChovyDefault`（紫 #8B5CF6 + 蓝 #3B82F6），
4 个内置备选；用户可在 `config.json` 加 `theme.custom` 深合并字段；运行时 `/theme set <name>` 切换。

## 产物

```
src/theme/
├── index.ts          # barrel: getTheme/setTheme/listThemes/onThemeChange
├── tokens.ts         # 5 个内置 Theme 字面量 + Theme 接口
├── resolve.ts        # name → Theme + custom 深合并
├── persist.ts        # 写 config.json 的 theme 段
└── inkColor.ts       # hex → Ink color name 16-color fallback

src/cli/slashCommands/theme.ts   # /theme list|set|create
```

## 实现要点

### 1. Theme 接口（B8 冻结）

见 `docs/tui/architecture.md §3 B8`。

```ts
// src/theme/tokens.ts
export interface Theme {
  name: string;
  primary: string; accent: string;
  bg: string; fg: string; muted: string;
  success: string; warning: string; error: string;
  borderStyle: "round" | "single" | "double" | "bold";
  spinnerFrames: string[];   // 默认 ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
}
export const ChovyDefault: Theme = {
  name: "ChovyDefault",
  primary: "#8B5CF6", accent: "#3B82F6",
  bg: "default", fg: "#E5E7EB", muted: "#6B7280",
  success: "#10B981", warning: "#F59E0B", error: "#EF4444",
  borderStyle: "round",
  spinnerFrames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"],
};
// + ChovyLight / ChovyHighContrast / ChovySolarized / ChovyMonochrome
export const BUILT_INS: Theme[] = [ChovyDefault, ChovyLight, ChovyHighContrast, ChovySolarized, ChovyMonochrome];
```

### 2. 单例 + 订阅（与 swarmStore 同模式）

```ts
// src/theme/index.ts
let _current: Theme = ChovyDefault;
const _listeners = new Set<(t: Theme) => void>();
export function getTheme(): Theme { return _current; }
export function setTheme(name: string): void {
  const next = resolveTheme(name, loadConfig().theme?.custom);
  _current = next;
  for (const l of _listeners) try { l(next); } catch {}
  persistTheme(name);                        // 写 config.json
  emit({ type: "tui.theme.change", name });  // telemetry 单源
}
export function onThemeChange(fn: (t: Theme) => void): () => void {
  _listeners.add(fn); return () => _listeners.delete(fn);
}
```

### 3. Ink color 映射

```ts
// src/theme/inkColor.ts
// Ink 5 接受 hex 真彩色（终端支持时）；不支持时按 16-color palette 找最近名字。
export function inkColor(hex: string, supportTrueColor: boolean): string {
  if (supportTrueColor) return hex;
  return nearestAnsi16(hex);  // {magenta/cyan/blue/red/yellow/green/white/black + bright*}
}
```

`tui/capabilities.ts`（step-33 产物）的 `supportTrueColor` 用于此处；构造时一次性算好。

### 4. config.json 深合并

```json
{
  "theme": {
    "name": "ChovyDefault",
    "custom": { "primary": "#FF6699" }
  }
}
```

`resolveTheme(name, custom)` 实现：取 `BUILT_INS` 找 name → 浅拷贝 → 把 `custom` 字段逐个覆盖（字段缺失保留 built-in 值）。

### 5. /theme slash 命令

```
/theme list                          → 列 5 个内置 + 当前
/theme set ChovyHighContrast         → 切换 + 持久化
/theme create my-theme primary=#fff  → 在 config.json 写一份新名字 + custom
```

## 接口冻结 / 不变量

- `Theme.name` / `primary` / `accent` 等字段冻结（B8）；扩展只追加可选字段。
- 持久化字段 `config.theme.name` / `config.theme.custom`（zod schema 在 step-02 既有 ChovyConfig 上**追加**可选字段）。
- `tui.theme.change` telemetry 单源 = `setTheme()`；其它模块**不**直发。

## 验收标准

- `bun run typecheck` 通过；
- `bun -e "import('./src/theme/index.js').then(m=>console.log(m.getTheme().name))"` 输出 `ChovyDefault`；
- `chovy chat` 启动后跑 `/theme set ChovyLight` → HeaderBar 边框颜色变化；重启 chovy 仍是 Light；
- `scripts/smoke-step31.ts`：临时 CHOVY_HOME → setTheme → 读 config.json 包含 `theme.name`；不漂移 secrets；
- 单文件 ≤ 200 行（每个 .ts）。

## 风险

- **真彩色探测不准**：Windows ConHost 旧版本不支持 24-bit 但 `COLORTERM` 可能误报；`inkColor` 兜底用 16-color。
  KNOWN-LIMITATIONS 里写「老 cmd.exe 显示降级」。
- **listener 泄漏**：所有 React 组件用 `useTheme()` hook（内部 useEffect cleanup），**不**手挂 `onThemeChange`。

## 参考源

- cc-haha `src/utils/theme.ts`（仅看接口形状，**不**抄字段名）；
- chalk / picocolors（不引依赖，仅参考 16-color fallback）。
