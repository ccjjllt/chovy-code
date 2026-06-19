# chovy-code TUI 架构总览（Phase J–P）

> 配合 `docs/tui/README.md` 阅读。本文聚焦：**新模块边界**、**依赖图**、**屏障同步点 B8/B9/B10**、
> **接口冻结时点**。任何要新加文件 / 新加依赖的 agent 都先在本文备案。

---

## 1. 新增目录树（30 步完成后）

```
src/
├── theme/                       # ★ Phase J · step-31
│   ├── index.ts                 # barrel: export type Theme, getTheme/setTheme
│   ├── tokens.ts                # ChovyDefault (violet+blue) / Light / HighContrast / Solarized
│   ├── resolve.ts               # 名称→Theme; cwd 配置 → 最终 Theme
│   └── persist.ts               # 写 config.json：theme.name / theme.custom
│
├── i18n/                        # ★ Phase J · step-32
│   ├── index.ts                 # t(key, params?) 全局函数 + LocaleProvider
│   ├── locales/
│   │   ├── zh-CN.ts             # 默认（中文）
│   │   └── en-US.ts             # 英文
│   ├── format.ts                # 数字/日期/百分比 locale-aware 格式化
│   └── detect.ts                # env LANG / config.locale 探测
│
├── keybindings/                 # ★ Phase J · step-34
│   ├── index.ts                 # registry + useKeybinding hook
│   ├── defaults.ts              # 全部默认键位（Ctrl+P / Ctrl+L / Ctrl+, …）
│   ├── parse.ts                 # "Ctrl+Shift+P" → KeyEvent matcher
│   └── persist.ts               # config.json 用户覆盖
│
├── tui/                         # ★ Phase J · step-33/35（共享布局 + 组件库）
│   ├── primitives/              # Layout 原语：Stack / SplitPane / Center / Constrain
│   ├── kit/                     # Panel / Card / Badge / Spinner / Divider / List
│   └── capabilities.ts          # 终端宽高 / 真彩色 / Unicode 探测
│
├── companion/                   # ★ Phase K（吉祥物）
│   ├── index.ts                 # CompanionHandle / mountCompanion()
│   ├── decoder.ts               # GIF→ARGB 帧序列（step-36）
│   ├── ansi.ts                  # ARGB 帧 → ANSI 半块字符串（step-36）
│   ├── cache.ts                 # ~/.chovy/cache/companion/*.ansi 帧缓存
│   ├── player.tsx               # Ink 组件 + setInterval 帧切换（step-37）
│   ├── stateMachine.ts          # idle/work/think/done/error → 不同 GIF（step-38）
│   ├── speechBubble.tsx         # 自绘气泡（不复刻 cc-haha 形状，step-39）
│   └── slashBuddy.ts            # /buddy 命令实现（step-40）
│
├── palette/                     # ★ Phase L（命令面板）
│   ├── index.tsx                # CommandPalette overlay
│   ├── registry.ts              # commands: { id, label, category, hotkey, run }
│   ├── search.ts                # 模糊匹配 + 中文分词（trigram + jieba 轻量替代）
│   ├── highlight.tsx            # 命中高亮渲染
│   └── recent.ts                # MRU 推荐排序
│
├── screens/                     # ★ Phase M/N（屏幕级组件）
│   ├── welcome.tsx              # WelcomeScreen 二栏（step-45）
│   ├── settings.tsx             # SettingsScreen 主屏（step-48）
│   └── settingsTabs/            # 4 个分类：general/provider/theme/keybind
│
└── cli/
    ├── repl.tsx                 # 已存在，本阶段做接入而非重写
    ├── components/
    │   ├── HeaderBar.tsx        # step-46 v2 改造
    │   ├── ToastHost.tsx        # step-55 新增
    │   ├── inputBoxV2.tsx       # step-53 新增（与既有 inputBox.tsx 并存→替换）
    │   └── …                    # 既有 SwarmPanel / GoalPanel 等不动
    └── slashCommands/
        ├── lang.ts              # /lang zh|en（step-32）
        ├── theme.ts             # /theme <name>（step-31）
        ├── buddy.ts             # /buddy pet|mute|skin（step-40）
        └── settings.ts          # /settings（与 Ctrl+, 等价入口）
```

---

## 2. 模块依赖图（DAG，无环）

```
                ┌────────────────┐
                │   config/      │  既有
                │   fs/          │  既有
                │   logger/      │  既有
                └───┬───────┬────┘
                    │       │
         ┌──────────┴──┐ ┌──┴──────────┐
         │  theme/     │ │  i18n/      │   ←── B8 (J 屏障): 接口冻结
         │  (step-31)  │ │  (step-32)  │
         └─────┬───────┘ └──────┬──────┘
               │                │
               └────────┬───────┘
                        │
              ┌─────────┴──────────┐
              │  tui/primitives    │  step-33
              │  tui/kit           │  step-35
              │  keybindings/      │  step-34
              └─┬────────┬───────┬─┘
                │        │       │
   ┌────────────┘        │       └────────────┐
   ▼                     ▼                    ▼
companion/           palette/             screens/
(step-36–40)         (step-41–44)         (step-45,48)
   │                     │                    │
   └────────┬────────────┴────────┬───────────┘
            ▼                     ▼
       cli/repl.tsx        cli/slashCommands
       (集成层 / 不重写)     (新增 lang/theme/buddy/settings)
            │
            ▼
       既有 engine / agent / providers / memory / context（**不依赖**反向）
```

**关键边规则**（与 AGENTS.md §17/§22/§23 同纪律）：

- `theme/` `i18n/` `keybindings/` `tui/` 是**叶子模块**：可被 `companion/` `palette/` `screens/` `cli/` 引用；
  **不**反向 import `engine` / `providers` / `agent` / `swarm` / `goals` / `memory` / `context` / `skills`。
- `companion/` `palette/` `screens/` 之间**互不**直接依赖（避免新模块互锁）：
  跨模块通信走 `cli/state/`（既有 `swarmStore.ts` 同模式）+ 事件总线（如 `companionBus`）。
- `cli/repl.tsx` 是**集成层**：可 import 全部新模块；新模块**不得**反向依赖 repl.tsx。

---

## 3. 屏障同步点

### B8 — Phase J 收尾（step-31..35 全部完成）

冻结接口：

```ts
// theme/index.ts
export interface Theme {
  name: string;                       // "ChovyDefault" | 自定义
  primary: string;                    // hex / "violet" / Ink color name
  accent: string;
  bg: string;
  fg: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  borderStyle: "round" | "single" | "double" | "bold";
  // 扩展只追加可选字段，不替换既有
}
export function getTheme(): Theme;
export function setTheme(name: string): void;
export function listThemes(): Theme[];

// i18n/index.ts
export type Locale = "zh-CN" | "en-US";  // 联合扩展只追加，不替换
export function t(key: string, params?: Record<string, string | number>): string;
export function getLocale(): Locale;
export function setLocale(loc: Locale): void;

// keybindings/index.ts
export interface KeyBinding { id: string; defaultKey: string; description: string; scope?: "global"|"input"|"palette"|"settings"; }
export function getBinding(id: string): string;        // 解析后的当前键
export function registerBinding(b: KeyBinding): void;
export function setUserBinding(id: string, key: string | null): void;  // null=恢复默认
```

**冻结点之后**：K/L/M/N/O 阶段任何步骤都**只能扩展**这些 surface（追加字段、追加方法），**不能改名**。

### B9 — Phase K 收尾（step-36..40 全部完成）

冻结接口：

```ts
// companion/index.ts
export type CompanionState = "idle" | "work" | "think" | "done" | "error";
export interface CompanionFrame { ansi: string; widthCols: number; heightRows: number; delayMs: number; }
export interface CompanionHandle {
  setState(s: CompanionState): void;
  pet(): void;                        // /buddy pet 触发的动画
  mute(b: boolean): void;
  skin(name: string): void;           // 切换到不同 GIF
  dispose(): void;
}
export function mountCompanion(opts: { cwd: string; muted?: boolean }): CompanionHandle;
```

**冻结点之后**：M（welcome）/ O（focus ring）只调用 handle，不跨边界改 state machine。

### B10 — Phase N 收尾（step-48..52 全部完成）

冻结接口：

```ts
// screens/settings.tsx 内部 + 暴露给 palette
export interface SettingsField {
  id: string;                                // "theme.name" / "providers.openai.model"
  label: string;                             // i18n key 或字面量
  category: "general"|"provider"|"theme"|"keybind";
  type: "text"|"select"|"toggle"|"hotkey"|"secret";
  read(): string;
  write(v: string): Promise<void>;
  options?: { value: string; label: string }[];   // type=select 用
  validate?(v: string): string | null;            // 返回错误文本 or null
}
export function listSettingsFields(): SettingsField[];
```

**冻结点之后**：O 阶段 `step-57` 接 settings 焦点，必须只通过该 surface。

---

## 4. 单源规约（与 AGENTS.md §16/§17/§18/§20/§21/§22/§23/§24 同模式）

| 数据 / 类型 | 单源位置 | 下游消费方 |
|---|---|---|
| `Theme` 联合 | `src/theme/tokens.ts` | repl / palette / settings / companion |
| `Locale` 联合 | `src/i18n/index.ts` | 所有 UI 文本调用 `t(key)` |
| `KeyBinding` 联合 | `src/keybindings/index.ts` | useKeybinding hook |
| `CompanionState` 联合 | `src/companion/index.ts` | repl / welcome / palette |
| `SettingsField` 联合 | `src/screens/settings.tsx` | palette / wizard |
| `palette.command` 注册项 | `src/palette/registry.ts` | repl / settings / slashCommands |
| **GIF 帧 ANSI 缓存** | `~/.chovy/cache/companion/<hash>/<frame>.ansi` | companion player |

**配置写盘单源**：所有 TUI 设置项（theme/locale/keybindings/companion.muted 等）写入 `~/.chovy/config.json`，
**禁止**写到 `secrets/`（与 AGENTS.md §26 一致）。

**telemetry 单源**：本阶段新增 4 个事件类型（与现有 `tool.call` / `agent.cost` / `swarm.dispatch` 等同模式）：

- `tui.theme.change`（step-31 emit 单点）
- `tui.locale.change`（step-32 emit 单点）
- `tui.palette.exec`（step-43 emit 单点）
- `tui.companion.skin`（step-40 emit 单点）

每个事件**只**在对应 owner 模块发射，repl/palette/settings 全部只是消费方。

---

## 5. 取消 / 副作用 / 性能不变量

- **取消独立 AC**（AGENTS.md §9 红线代码化）：`companion/decoder.ts` 解 GIF 时拿 `parentSignal`
  必须本地 `new AbortController()` 包装，不直接 forward 给 `safeFs.read`。
- **GIF 解码副作用**：仅本地写 `~/.chovy/cache/companion/`；首次解码后帧缓存 hash 化文件名，
  下次启动直接读缓存（启动时间 < 200ms 目标）。
- **Ink 渲染节流**（AGENTS.md §22 step-22 同模式）：companion 帧切换 ≥ 80ms（12 fps 上限），
  speech bubble fade 16ms 节流；palette 搜索 debounce 80ms。
- **Windows ConHost 闪烁兜底**（接 §22 `CHOVY_NO_SWARM_PANEL` 同模式）：
  - `CHOVY_NO_COMPANION=1` → 禁用吉祥物挂载，显示纯文字 ASCII fallback
  - `CHOVY_NO_PALETTE=1` → Ctrl+P 改成 inline 列表（不 overlay）
  - `CHOVY_NO_TUI=1` → 顶层兜底，整个新 TUI 退化到 step-30 既有形态
- **依赖**：本阶段**不引入**新 npm 依赖；GIF 解码用 Bun 内置 `Bun.file` + 自实现解码或复用既有
  React/Ink；如必须加（如 `omggif`），在 step-36 spec 内**显式**列出理由 + 大小，PR 描述里说明。

---

## 6. 与既有 chovy-code 模块的接口边

- **`src/cli/repl.tsx`**：本阶段**不重写**。step-39/41/45/48/57 都是在 repl 内**追加** mount 点：
  - 顶部 `WelcomeScreen` 仅在 messages 仅含 init system message 时渲染（step-45）；
  - `<CompanionHost />` mount 在 InputBox 旁（step-39）；
  - `<CommandPalette />` 通过 `paletteOpen` state 切换 overlay（step-41）；
  - `<SettingsScreen />` 通过 `settingsOpen` state 切换全屏（step-48）；
  - 焦点环在 step-57 重写，但 5-way ring 仍是 `useState` 驱动。
- **`src/cli/components/HeaderBar.tsx`**：step-46 改造，仍保持既有 `BudgetSnapshot` / `SwarmSummary` props
  签名（AGENTS.md §22/§23 frozen-extension）。
- **`src/cli/configWizard.ts`**：step-52 重构为「ConfigWizard 调用 SettingsScreen 内部 field 写入」，
  外部 surface（CLI 子命令、`/config` slash）保持不变（AGENTS.md §26 配置入口不变量）。
- **`src/cli/slashCommands.ts`**：step-32/31/40 新增 `/lang` `/theme` `/buddy` 三个条目；
  step-44 让所有 slash 同步进 palette registry（同一命令两条入口）。

---

## 7. 测试 / smoke 约定

每个 step 必须自带一份 `scripts/smoke-step-XX.ts`（与既有 `smoke-step29.ts` 同口径）：

- 不依赖网络 / 真实 provider / 真实 `~/.chovy`（全部用 `tmpdir` 隔离）；
- Bun spawn 子进程跑构建产物（不允许直接 import Ink 组件 render，避免 Ink 在 CI 卡死 stdin）；
- regex 断言关键产物（如 `/theme.*ChovyDefault/`）；
- 每个 smoke 内置 5s 超时 + 显式 abort。

完整 TUI E2E 在 step-59 落地，统一进 `bun run smoke` 主入口。

---

## 8. 行数 / 复杂度上限

- 新增文件如超 400 行，step 文档「风险」段必须显式说明并预留拆分时点。
- TUI 组件 props 接口 ≤ 8 字段；超 8 个改用 `config: { … }` 集合 prop（Ink 习惯）。
