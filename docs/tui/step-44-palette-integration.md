# Step 44 — 集成既有 slash + 配置项 + 跳转设置

**Phase**: L | **依赖**: 42, 43 | **估时**: 3h

## 目标

把命令面板与既有系统**全部打通**：

1. 所有既有 `slashCommands`（`/help` `/goal` `/mem` `/skill` `/checkpoint` `/buddy` `/lang` `/theme` 等）
   自动同步进 palette registry；
2. step-49/50/51 的设置项（model / theme / locale / keybinding）注册成 "跳转设置" 类命令；
3. 命令运行结果回 InputBox 时不打断当前编辑（保留 draft）；
4. CommandPalette 替代 `?/help` overlay 成为主入口（HelpOverlay 仍保留作 quick reference）。

## 产物

```
src/palette/
├── slashBridge.ts      # 把 slashCommands.ts 的 entry 包成 PaletteCommand
└── settingsBridge.ts   # 把 SettingsField 包成 "open settings @ <field>" 命令

src/cli/repl.tsx        # 接入：在 mount 时调用 registerSlashAsPalette()
                        # + Ctrl+P 真实开启 + 焦点环更新
```

## 实现要点

### 1. slashBridge.ts

```ts
// src/palette/slashBridge.ts
import { slashCommands } from "../cli/slashCommands.js";

export function registerSlashAsPalette(): void {
  for (const [name, entry] of Object.entries(slashCommands)) {
    if (entry.hidden) continue;     // 内部命令不暴露（如 /quit 实际暴露，/_debug 不暴露）
    registerCommand({
      id: `slash.${name}`,
      label: () => `/${name} — ${t(entry.helpKey ?? "")}`,
      category: entry.category ?? "tools",
      hotkey: entry.hotkeyId,
      aliases: entry.aliases,
      run: async (ctx) => {
        // 关闭 palette 后回到 InputBox，预填 "/<name> "（不直接执行——用户可补参数）
        ctx.prefillInput?.(`/${name} `);
      },
    });
  }
}
```

> 「预填」而非「直接执行」是有意的：很多 slash 命令需要参数（`/goal <objective>`、`/theme set <name>`）。
> 一键执行的命令（如 `/help`、`/clear`）注册成 `direct: true` 跑 `entry.handler("", ctx)`。

需要为 `slashCommands` 既有 entry 加可选元数据：

```ts
// src/cli/slashCommands.ts （现有文件追加可选字段）
export interface SlashEntry {
  handler: SlashHandler;
  help: string;
  helpKey?: string;          // i18n key（推荐）
  category?: PaletteCategory;
  aliases?: string[];
  hotkeyId?: string;
  direct?: boolean;          // 不需参数
  hidden?: boolean;          // palette 不显示
}
```

step-32 + step-43 已 prep；本步**只追加 6 个可选字段**到既有 SlashEntry，frozen-extension 兼容。

### 2. settingsBridge.ts

```ts
// 等 step-49/50/51 落地后注册：
import { listSettingsFields } from "../screens/settings.js";
export function registerSettingsAsPalette(): void {
  for (const f of listSettingsFields()) {
    registerCommand({
      id: `settings.${f.id}`,
      label: () => `${t("palette.goto.settings")}: ${f.label}`,
      category: "settings",
      run: (ctx) => ctx.openSettings?.(f.id),    // 打开 SettingsScreen + 跳到该 field
    });
  }
}
```

`ctx.openSettings(fieldId?)` 需要 ReplCtx 新加方法（step-48 落地）。

### 3. ReplCtx 扩展（向后兼容）

```ts
// src/cli/slashCommands.ts 既有 ReplCtx 追加可选字段：
export interface ReplCtx {
  // ... 既有字段 ...
  prefillInput?: (text: string) => void;
  openSettings?: (fieldId?: string) => void;
}
```

`prefillInput` 由 InputBox 实现，保留 draft 逻辑（step-53 v2 完善）。

### 4. Welcome screen / 启动屏推荐

新手首启动 chovy 时（step-45 WelcomeScreen），底部 Tips 区显示：

```
按 Ctrl+P 打开命令面板（推荐）
```

让用户立即知道入口。step-47 实现。

### 5. HelpOverlay 与命令面板的关系

- `?/help` 仍打开 HelpOverlay（既有，简短列出 slash 命令快查）；
- Ctrl+P 是**主**入口（更全、可搜索、可执行）；
- HelpOverlay 底部加一行：「按 Ctrl+P 进入命令面板」。

### 6. 焦点环更新（与 step-57 协调）

paletteOpen 时 InputBox `useInput.isActive=false`；palette 关闭时恢复。
当前焦点环（`"input"|"swarm"|"goal"`）扩展为 `"input"|"swarm"|"goal"|"palette"|"companion"`，但 palette **不进入 Tab 环**——用 Ctrl+P 唯一入口（避免误开）。

## 接口冻结 / 不变量

- `SlashEntry` 6 字段扩展是**追加**（frozen-extension）；旧 entry 仍工作。
- `ReplCtx.prefillInput` / `openSettings` 是**可选**（防止旧调用方崩溃）。
- 命令面板**不**改 `slashCommands` 主体行为：slash 入口仍可正常用（`/help` 在 InputBox 输入）。
- direct=true 命令在 palette 内执行后**不**回到 InputBox 写入 `/cmd`（避免误触发两次）。

## 验收标准

- `bun run typecheck` 通过；
- chovy + Ctrl+P → 至少看到 15 条 slash 命令（既有 12 个 + 新加 buddy/lang/theme）；
- 选 `/goal —` → 关闭 palette + InputBox 预填 `/goal `；
- 选 `/help` → palette 关闭 + HelpOverlay 弹出（direct=true）；
- step-49 落地后：palette 含 "打开设置: 主题"；选 → SettingsScreen 弹出聚焦在 theme tab；
- `scripts/smoke-step44.ts`：模拟 registerSlashAsPalette → registry 新增 N 条，N === Object.keys(slashCommands).length（去掉 hidden）。

## 风险

- **slash 重复注册**：本步只在 cli/index.tsx 入口调用一次 `registerSlashAsPalette()`；多次调用会触发 duplicate-id 抛错（step-43 的 INTERNAL）—— 这是想要的「fail-fast」行为。
- **prefillInput 时机**：palette 关闭与 InputBox 重新激活之间有渲染间隔；用 useEffect + nextTick 确保 prefill 在 input 显示后写入。
- **设置跳转 fieldId 不存在**：catch 异常 + warn + 默认打开 General 类。
