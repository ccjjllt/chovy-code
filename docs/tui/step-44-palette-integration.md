# Step 44 — 集成 slash / settings / skills / plugins / workflows

**Phase**: L | **依赖**: 42, 43 | **估时**: 3h

## 目标

把命令面板与既有系统**全部打通**：

1. 所有 slash 命令是 `PaletteCommand.slash` 的一个视图，不再维护独立 bridge 列表；
2. step-49/50/51 的设置项注册成 "打开设置 → field" 命令；
3. CSG skills、plugin commands、workflow commands、MCP commands 通过 `cli/commandSources.ts` 进入 Ctrl+P 与 `/` autocomplete；
4. 命令运行结果回 InputBox 时不打断当前编辑（保留 draft）；
5. Step-44 验收必须满足 `commandEquivalents >= 72`，并覆盖 `command-skill-coverage.md` 全部 command group。

## 产物

```
src/cli/
├── commandSources.ts        # slash/settings/skills/plugins/workflows/mcp 适配层
└── repl.tsx                 # 启动时 registerAllCommandSources()

src/palette/
└── settingsSource.ts        # SettingsField → PaletteCommand（若不放 cli/，只能依赖 screens surface）
```

## 实现要点

### 1. commandSources.ts

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

`palette/` 不直接 import `skills/` / `plugins/` / `workflows/`；所有后端来源都在 `cli/commandSources.ts` 适配，保持 TUI 模块 DAG 无环。

参考 cc-haha `src/commands.ts` 的聚合纪律：先收集 bundled skills、project/user skills、plugin commands、workflow commands、MCP commands、内置命令，再统一做 availability / enabled / hidden 过滤。chovy 的差异是聚合结果进入 MiMo 式 `PaletteCommand`，但过滤顺序必须同样可解释，不能由各个 UI 组件自己临时过滤。

`registerAllCommandSources()` 的输出必须同时服务 Ctrl+P、HelpOverlay 与 InputBox `/` autocomplete；任何新来源若只接入其中一个入口，不计入 `commandEquivalents`。

### 2. SlashEntry 元数据

既有 slash handler 保持原行为，只追加元数据：

```ts
export interface SlashEntry {
  handler: SlashHandler;
  help: string;
  helpKey?: string;
  category?: PaletteCategory;
  aliases?: string[];
  argsHint?: string;
  hotkeyId?: string;
  direct?: boolean;
  suggested?: boolean;
  hidden?: boolean | ((ctx: ReplCtx) => boolean);
  enabled?: boolean | ((ctx: ReplCtx) => boolean);
  source?: "slash";
}
```

注册策略：

- `direct=true`：从 Ctrl+P 选择后直接执行 handler；
- `direct=false`：关闭 palette，回到 InputBox 并预填 `/<name> `；
- `suggested=true`：进入推荐区，但仍必须在普通分组里可搜索；
- 需要 backend 的命令用 `enabled(ctx)` 或 `hidden(ctx)`，不可裸露一个无效按钮。

### 3. Slash 命令目录

以下是 Phase L 需要覆盖的 slash 目录；详细计数与 smoke gate 见 `command-skill-coverage.md`。

| Group | Slash commands |
|---|---|
| Session / transcript | `/new`, `/sessions`, `/resume`, `/continue`, `/rename`, `/compact`, `/summarize`, `/copy`, `/export`, `/clear`, `/quit`, `/exit`, `/q`, `/rewind`, `/timeline`, `/branch`, `/diff` |
| Prompt / message | `/editor`, `/paste`, `/undo`, `/redo`, `/thinking`, `/tool-details`, `/timestamps`, `/vim` |
| Provider / model | `/provider`, `/providers`, `/model`, `/models`, `/variants`, `/fast`, `/effort`, `/output-style`, `/rate-limit`, `/usage`, `/cost`, `/extra-usage` |
| Config / settings | `/config`, `/configure`, `/settings`, `/theme`, `/themes`, `/color`, `/lang`, `/language`, `/keybindings`, `/keys`, `/privacy`, `/permissions`, `/sandbox`, `/hooks`, `/statusline` |
| Agents / goals / memory | `/agents`, `/tasks`, `/workflows`, `/plan`, `/goal`, `/checkpoint`, `/memory`, `/mem`, `/context`, `/stats` |
| Skills / plugins / MCP | `/skills`, `/skill`, `/skill-reload`, `/skill-doctor`, `/skill-create`, `/plugin`, `/reload-plugins`, `/mcp`, `/files`, `/add-dir`, `/init` |
| Diagnostics / review / safety | `/status`, `/doctor`, `/help`, `/?`, `/release-notes`, `/upgrade`, `/review`, `/ultrareview`, `/security-review`, `/pr-comments`, `/feedback`, `/heap-dump`, `/terminal-setup`, `/install-github-app`, `/install-slack-app` |
| Companion / TUI | `/buddy`, `/buddy pet`, `/buddy size`, `/buddy hide`, `/buddy mute`, `/buddy skin`, `/background`, `/logo`, `/debug` |

GUI / remote / provider 专属命令可以在后端不存在时 `hidden`，或以 `enabled=false` 显示并给出原因；但只要当前构建不可实际执行，就**不得**计入 72-command acceptance gate。

### 4. SettingsField commands

```ts
export function registerSettingsFieldsAsPalette(): void {
  for (const f of listSettingsFields()) {
    registerCommand({
      id: `settings.${f.id}`,
      label: () => `${t("palette.goto.settings")}: ${t(f.label)}`,
      category: "settings",
      source: "settings",
      run: (ctx) => ctx.openSettings?.(f.id),
    });
  }
}
```

`ctx.openSettings(fieldId?)` 由 step-48 落地。field 不存在时默认打开 General 并 toast warning。

### 5. Skill commands

```ts
export async function registerSkillCommandsAsPalette(): Promise<void> {
  const skills = await listDiscoveredSkills();
  registerCommand({
    id: "skills.open",
    label: () => t("palette.skills.open"),
    category: "skills",
    slash: { name: "skills" },
    source: "skill",
    run: (ctx) => ctx.openSkillPicker?.(),
  });
  for (const skill of skills) {
    if (isBuiltinSlashName(skill.name)) continue;
    registerCommand({
      id: `skill.${skill.name}`,
      label: () => skill.name,
      description: () => skill.summary,
      category: "skills",
      slash: { name: skill.name, argsHint: "[args]" },
      source: "skill",
      direct: false,
      run: (ctx) => ctx.prefillInput?.(`/${skill.name} `),
    });
  }
}
```

`/skill list|show|plan|use|clear|reload|doctor|create` 继续走 `src/cli/slashCommands/skill.ts`；`/<skill-name>` 是便捷入口，只有不冲突时注册。

### 6. ReplCtx 扩展

```ts
export interface ReplCtx {
  prefillInput?: (text: string) => void;
  openSettings?: (fieldId?: string) => void;
  openSkillPicker?: () => void;
}
```

`prefillInput` 由 InputBox v2 完善：如果当前 draft 非空，先 toast 提示并允许覆盖/插入，而不是静默丢 draft。

### 7. HelpOverlay 与命令面板

- `?/help` 仍打开 HelpOverlay，作为简短 quick reference；
- Ctrl+P 是主入口，列出更多命令、skills、settings、plugin/workflow；
- HelpOverlay 的数据来自 `listSlashes()`，不维护静态表。

## 接口冻结 / 不变量

- `SlashEntry` 字段扩展是**追加**（frozen-extension）；旧 entry 仍工作。
- `ReplCtx.prefillInput` / `openSettings` / `openSkillPicker` 是**可选**。
- 命令面板**不**改 slash handler 主体行为：用户手动输入 `/help` 仍走同一路径。
- direct=true 命令在 palette 内执行后**不**回到 InputBox 写入 `/cmd`。
- `/<skill-name>` 不得覆盖内置 slash；冲突时只在 `/skills` picker 里显示。
- API key / secrets 状态类命令只显示 configured/missing，不显示明文。

## 验收标准

- `bun run typecheck` 通过；
- `scripts/smoke-step44.ts`：`commandEquivalents >= 72`；
- `scripts/smoke-step44.ts`：每个 group 至少一条 visible command，且 hidden backend-specific command 不计数；
- `scripts/smoke-step44.ts`：输出 `bySource`，至少包含 `slash` / `settings` / `skill` 三类；plugin/workflow/MCP 后端不可用时必须列入 `hiddenOrUnavailable`，不得计数；
- chovy + Ctrl+P → 能看到 slash、settings、skills 三类来源；
- 输入 `/go` → autocomplete 命中 `/goal`；输入 `/skill` → 命中 `/skill` 与 `/skills`；
- 选 `/goal` → 关闭 palette + InputBox 预填 `/goal `；
- 选 `/help` → palette 关闭 + HelpOverlay 弹出（direct=true）；
- step-49 落地后：palette 含 "打开设置: 主题"；选 → SettingsScreen 聚焦 theme tab；
- bundled skills ≥15 后：`/skills` picker 至少显示 15 个 bundled skills。

## 风险

- **命令数量膨胀**：搜索展示仍由 step-42 截断前 50 高分；registry 不截断。
- **后端来源失败**：每个 source 独立 catch；失败只 toast/warn，不让 Ctrl+P 空白。
- **prefillInput 时机**：palette 关闭与 InputBox 重新激活之间有渲染间隔；用 next tick 写入。
- **覆盖指标造假**：smoke 只计 `run` 有实际行为、或有 backend predicate 的 command；纯 TODO 不计入 `commandEquivalents`。
