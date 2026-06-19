# Step 43 — 命令注册中心（MiMo 式 command store + cc-haha 覆盖门槛）

**Phase**: L | **依赖**: 41 | **可并行**: 42、CSG-R skill catalogue | **估时**: 4h

## 目标

把所有可用动作收敛到一个 MiMo 式 command store：

- `slash` 是 command option 的一个视图，不维护第二份 slash 列表；
- 支持 `suggested` / `hidden` / `enabled` / `source` / `direct`；
- 内置命令、slash、SettingsField、skills、plugins、workflows、MCP 命令都通过 `cli/commandSources.ts` 适配进 registry；
- 推荐区按 MRU 排序；
- 分类按 i18n key 显示；
- `tui.palette.exec` telemetry 单源在此模块发射；
- Phase L 验收必须满足 `docs/tui/command-skill-coverage.md` 的 **≥72 个 cc-haha 等价命令**门槛。

## 产物

```
src/palette/
├── registry.ts        # CommandOption 注册 / 查询 / trigger / slashes
├── recent.ts          # MRU 持久化（~/.chovy/cache/palette-mru.json）
├── builtin.ts         # 默认 TUI 命令源
└── group.ts           # filter + group + flatten

src/cli/
└── commandSources.ts  # slash / settings / skills / plugins / workflows / mcp → PaletteCommand
```

## 实现要点

### 1. PaletteCommand

```ts
export type PaletteCategory =
  | "recommend" | "session" | "agent" | "model" | "provider" | "settings"
  | "prompt" | "message" | "goal" | "memory" | "skills"
  | "companion" | "diagnostics" | "tools" | "external";

export interface PaletteCommand {
  id: string;                     // 唯一，如 "session.switch"
  label: () => string;            // i18n 切换后即时生效
  description?: () => string;
  category: PaletteCategory;
  hotkey?: string;                // keybinding id；显示文本从 keybindings 单源拿
  run: (ctx: ReplCtx) => Promise<void> | void;
  enabled?: boolean | ((ctx: ReplCtx) => boolean);
  hidden?: boolean | ((ctx: ReplCtx) => boolean);
  suggested?: boolean | ((ctx: ReplCtx) => boolean);
  direct?: boolean;               // true 直接执行，false 预填 slash / 打开二级输入
  slash?: { name: string; aliases?: string[]; argsHint?: string };
  source?: "builtin" | "slash" | "settings" | "skill" | "plugin" | "workflow" | "mcp";
  keywords?: string[];            // 英文 + 中文搜索增强
}
```

`id` duplicate 直接抛 `INTERNAL`；`hidden` 不显示；`enabled=false` 显示但不可执行并给出原因。

### 2. 单源 command store

```ts
const store = new Map<string, PaletteCommand>();

export function registerCommand(c: PaletteCommand): void {
  if (store.has(c.id)) throw new ChovyError("INTERNAL", `duplicate palette command: ${c.id}`);
  store.set(c.id, c);
}

export function listCommands(ctx: ReplCtx): PaletteCommand[] {
  return [...store.values()].filter((c) => {
    const hidden = typeof c.hidden === "function" ? c.hidden(ctx) : c.hidden;
    return !hidden;
  });
}

function commandEnabled(c: PaletteCommand, ctx: ReplCtx): boolean {
  return typeof c.enabled === "function" ? c.enabled(ctx) : c.enabled !== false;
}

export function listSlashes(ctx: ReplCtx): SlashSuggestion[] {
  return listCommands(ctx).flatMap((c) => {
    if (!commandEnabled(c, ctx)) return [];
    if (!c.slash) return [];
    return [
      { display: "/" + c.slash.name, commandId: c.id, description: c.description?.() ?? c.label() },
      ...(c.slash.aliases ?? []).map((a) => ({ display: "/" + a, commandId: c.id, description: c.description?.() ?? c.label() })),
    ];
  });
}
```

InputBox v2、HelpOverlay、CommandPalette 都读 `listCommands` / `listSlashes`，不再读独立 slash registry。Ctrl+P 可以展示 `enabled=false` 的条目并说明原因；`/` autocomplete 只展示当前可执行条目，避免补全出无效命令。

### 3. commandSources.ts

`palette/` 不直接 import `skills/` / `plugins/` / `workflows/`。集成层负责适配：

```ts
export async function registerAllCommandSources(ctx: ReplCtx): Promise<void> {
  registerBuiltinPaletteCommands();
  registerSlashCommandsAsPalette();
  registerSettingsFieldsAsPalette();
  await registerSkillCommandsAsPalette();
  await registerPluginCommandsAsPalette();
  await registerWorkflowCommandsAsPalette();
  await registerMcpCommandsAsPalette();
}
```

错误隔离：某一来源加载失败只 toast/warn，不让 Ctrl+P 空白。

### 4. 覆盖组

实际命令清单在 `command-skill-coverage.md` 单源维护。step-43 只规定分组与验收：

| Group | Category | Gate |
|---|---|---|
| Session / transcript | `session` | new/resume/rename/compact/copy/export/clear/quit/rewind/branch/diff 等 |
| Prompt / input | `prompt` / `message` | editor/paste/undo/redo/thinking/tool-details/timestamps/vim |
| Provider / model | `provider` / `model` | provider/model/variants/fast/effort/output-style/rate-limit/usage/cost |
| Config / settings | `settings` | config/settings/theme/lang/keybindings/privacy/permissions/sandbox/hooks |
| Agents / goals / memory | `agent` / `goal` / `memory` | agents/tasks/workflows/plan/goal/checkpoint/memory/context/stats |
| Skills / plugins / MCP | `skills` / `tools` / `external` | skills/skill/plugin/reload/mcp/files/add-dir/init |
| Diagnostics / safety | `diagnostics` | status/doctor/help/release-notes/review/security-review/pr-comments |
| Companion / TUI | `companion` | buddy size/hide/mute/skin/debug/background/logo |

`scripts/smoke-step43.ts` 需要输出 `{ commandEquivalents, byGroup, bySource, nonCounted }`，并断言 `commandEquivalents >= 72`；`nonCounted` 必须列出 hidden / disabled / TODO / backend-missing 的原因。

### 5. MRU 推荐

```json
{
  "items": {
    "model.switch": { "count": 12, "lastUsedAt": 1718800000000 },
    "session.new":  { "count":  3, "lastUsedAt": 1718700000000 }
  },
  "v": 1
}
```

推荐 score：

```ts
function mruScore(count: number, lastUsedAt: number, now: number): number {
  const ageDays = (now - lastUsedAt) / 86_400_000;
  return count * Math.exp(-ageDays / 30);
}
```

空 query 时先展示 `suggested=true` 的命令，再展示 MRU 前 5。

### 6. 执行 + telemetry

```ts
export async function execCommand(item: PaletteCommand, ctx: ReplCtx): Promise<void> {
  closePalette();
  bumpMru(item.id);
  emit({ type: "tui.palette.exec", id: item.id, source: item.source ?? "builtin", locale: getLocale() });
  if (item.enabled !== undefined && !commandEnabled(item, ctx)) return ctx.appendSystem(t("palette.command.disabled"));
  try { await item.run(ctx); }
  catch (err) {
    logger.warn(`palette ${item.id} failed: ${err}`);
    ctx.appendSystem(t("toast.cmdFailed", { name: item.id, msg: err instanceof Error ? err.message : String(err) }));
  }
}
```

## 接口冻结 / 不变量

- `PaletteCommand` 字段冻结；扩展只追加。
- `tui.palette.exec` telemetry 单源在 `execCommand`；其它模块**禁止**直发。
- `palette/` 不直接 import `skills/` / `plugins/` / `workflows/`。
- MRU 文件失败（写 / 读）→ warn + 用空 store，**不**让 palette 拒绝打开。
- 展示层 top-N 截断在 step-42；registry 不限制命令总数，避免 slash/skills 扩展后丢命令。
- `CHOVY_NO_PALETTE=1` 只禁 overlay，不禁 `listSlashes()`，InputBox slash 仍可用。

## 验收标准

- `bun run typecheck` 通过；
- `scripts/smoke-step43.ts`：注册 5 条命令 → query="" 看到 suggested/MRU；exec 一次后 MRU 生效；
- `scripts/smoke-step43.ts`：`commandEquivalents >= 72`，每个覆盖组至少 1 条 visible command，并输出 `byGroup` / `bySource` / `nonCounted`；
- chovy + Ctrl+P → 能看到 session / model / provider / settings / message / skills / companion / diagnostics 分组；
- 分组标题中文（locale=`zh`）；切换 `setLocale("en")` 后标题英文；
- exec 一条命令 → 关闭 palette + telemetry 写一条 `tui.palette.exec`；
- 打开命令面板时 hotkey 列与 step-34 当前生效键一致。

## 风险

- **注册时机**：`registerAllCommandSources()` 必须在 REPL 挂载前完成；否则首次 Ctrl+P 列表为空。
- **来源失败**：plugin/workflow/skill 加载不可影响内置命令；每个 source 独立 try/catch。
- **覆盖数虚高**：只计有实际行为的命令；纯占位、未接 backend、无 disabled predicate 的条目不得计入 `commandEquivalents`。
- **MRU 文件竞态**：多进程并发写 mru.json → 用 atomic write（写 tmp + rename），失败 fallback 为只读最新版。
