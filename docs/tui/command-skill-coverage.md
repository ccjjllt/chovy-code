# TUI Command / Skill 覆盖计划

> 范围：**计划合约**，不是实现。本文定义 Phase L / O / P 必须在 TUI 暴露哪些命令、skills 与发现来源，以及如何验证“对齐 cc-haha / MiMo，但不照搬实现”。

---

## 1. 参考源码结论

已核对的参考点：

| 参考源 | 观察到的设计 | chovy 计划采用方式 |
|---|---|---|
| MiMo `packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx` | `CommandOption` 同时承载 `suggested` / `hidden` / `enabled` / `slash`；命令面板、快捷键、slash 视图来自同一组注册项 | `PaletteCommand` 也把 slash 作为 command 的一个字段，不维护第二套 slash registry |
| MiMo `component/prompt/autocomplete.tsx` | `/` autocomplete 先合并 command store 的 slashes，再合并 server commands；搜索结果带 description/source | chovy InputBox v2 的 `/` 补全必须读 `listSlashes()` + `cli/commandSources.ts`，并标注 source |
| MiMo `context/language.tsx` | 英文 base dictionary；非英文 loader + cache；用户保存 `preference`，渲染用 `effective`；`UiI18nBridge` 注入 UI 包 | chovy `i18n/` 完全采用 preference/effective/base/loader/cache/bridge 结构；只内置 `zh` / `en`，兼容 `zh-CN` / `en-US` alias |
| MiMo `src/skill/index.ts` | skill discovery 覆盖 bundled、配置目录、外部 `.claude/.agents/.codex/.opencode`、显式路径和远端 URL | chovy Phase L 只做本地与只读外部发现；远端 URL 延后，需单独 install/cache/确认策略 |
| cc-haha `src/commands.ts` | 内置命令 + bundled skills + skill dirs + plugin commands + workflows + dynamic skills 汇总后再按 availability/isEnabled 过滤 | chovy 用 `cli/commandSources.ts` 作为唯一适配层，palette 不直接 import `skills/` / `plugins/` / `workflows/` |
| cc-haha `src/skills/bundled/` | bundled skills 包含 verify/debug/stuck/simplify/remember/skillify/batch/loop/schedule/claude-api/claude-in-chrome 等，并有 feature gate | chovy 保留 CSG 图结构，不平铺照搬；至少扩到 15 个 bundled skills |

差异化红线：

- 不复制 MiMo 的 Solid/OpenTUI 组件实现；chovy 继续用 Bun + Ink。
- 不复制 cc-haha 的 command module 代码、buddy sprite、rarity、hatch/release 机制。
- 不把远端 skill index 放进 Phase L；远端安装另开后续阶段。
- 不把禁用/隐藏/未接 backend 的命令计入 80% 覆盖。

---

## 2. 覆盖目标

| 项目 | 参考基线 | chovy 验收线 | 验收位置 |
|---|---:|---:|---|
| 用户可见命令等价行为 | cc-haha 约 86 个用户可见命令入口（排除 internal-only 与纯 feature-gated） | `commandEquivalents >= 72` | step-43 / step-44 smoke |
| bundled skills | cc-haha bundled skills 约 16+ 个，其中部分 feature-gated | `bundledSkills >= 15`，且现有 7 个不能丢 | Phase L/P smoke |
| slash / palette 单源 | MiMo command store | 100%：HelpOverlay、Ctrl+P、`/` autocomplete 都读同一 registry | step-44 / step-53 |
| i18n 描述 | MiMo dictionary | 所有命令 label/description 走 zh/en key；命令名仍英文 | step-32 / step-43 |

---

## 3. 命令覆盖门槛

Phase L 必须把下列命令组接入同一个 command registry。Ctrl+P 与 `/` 是同一 command 的两种视图。

| Group | 最少计数 | 必做代表命令 |
|---|---:|---|
| Session / transcript | 13 | `/new`, `/sessions`, `/resume`, `/rename`, `/compact`, `/copy`, `/export`, `/clear`, `/quit`, `/rewind`, `/timeline`, `/branch`, `/diff` |
| Prompt / input | 8 | `/editor`, `/paste`, `/undo`, `/redo`, `/thinking`, `/tool-details`, `/timestamps`, `/vim` |
| Provider / model | 12 | `/provider`, `/providers`, `/model`, `/models`, `/variants`, `/fast`, `/effort`, `/output-style`, `/rate-limit`, `/usage`, `/cost`, `/extra-usage` |
| Config / settings | 13 | `/config`, `/settings`, `/theme`, `/themes`, `/color`, `/lang`, `/language`, `/keybindings`, `/privacy`, `/permissions`, `/sandbox`, `/hooks`, `/statusline` |
| Agents / goals / memory | 10 | `/agents`, `/tasks`, `/workflows`, `/plan`, `/goal`, `/checkpoint`, `/memory`, `/mem`, `/context`, `/stats` |
| Skills / plugins / MCP | 10 | `/skills`, `/skill`, `/skill-reload`, `/skill-doctor`, `/skill-create`, `/plugin`, `/reload-plugins`, `/mcp`, `/files`, `/add-dir`, `/init` |
| Diagnostics / review / safety | 14 | `/status`, `/doctor`, `/help`, `/release-notes`, `/upgrade`, `/review`, `/ultrareview`, `/security-review`, `/pr-comments`, `/feedback`, `/heap-dump`, `/terminal-setup`, `/install-github-app`, `/install-slack-app` |
| Companion / TUI polish | 7 | `/buddy`, `/buddy size`, `/buddy hide`, `/buddy mute`, `/buddy skin`, `/background`, `/logo`, `/debug` |

总清单超过 86 个命名入口，但验收不是简单数名字。命令计入 `commandEquivalents` 必须满足：

- 有实际行为：直接执行、打开 picker、跳转 settings field、或安全预填并有参数校验。
- 有 zh/en i18n label 与 description。
- 有 slash autocomplete metadata：`slash.name`、aliases、argsHint/source（按需）。
- backend 不存在时必须 `hidden` 或 `enabled=false`，且不可计数。
- API key、secrets、provider token 状态只显示 `configured/missing`，不显示明文。

不计数：

- 纯 TODO / 纯占位 / 只 toast “coming soon”。
- 只有 Ctrl+P 条目但没有 run/prefill/settings jump 行为。
- feature-gated 且当前构建不可用的命令。
- 需要外部 connector 但没有 connector 时仍 visible 的假入口。

### 3.1 每组最低行为

下面是行为验收线。实现时可以比它更强，但不能低于它；否则即使命令名存在也不计入 `commandEquivalents`。

| Group | 最低可计数行为 |
|---|---|
| Session / transcript | 新建/切换/恢复会话必须影响当前 session id；rename/export/copy/clear/rewind/timeline/branch/diff 至少完成本地状态、文件或只读预览中的一个真实动作 |
| Prompt / input | editor/paste/undo/redo/vim 必须改变 InputBox 或编辑模式；thinking/tool-details/timestamps 必须改变 MessageList 展示配置 |
| Provider / model | provider/model/variant/effort/output-style/rate-limit 必须打开 picker 或写配置；usage/cost/extra-usage 必须读取真实会话/配置统计或明确显示 unavailable 且不计数 |
| Config / settings | config/settings/theme/lang/keybindings/privacy/permissions/sandbox/hooks/statusline 必须跳转 SettingsField、调用现有 config wizard，或切换真实 runtime/config 状态 |
| Agents / goals / memory | agents/tasks/workflows/plan/goal/checkpoint/memory/context/stats 必须复用已有 runtime 或只读展示真实状态；没有对应 runtime 的 workflow 命令 hidden |
| Skills / plugins / MCP | skills/skill 必须复用 CSG runtime；plugin/workflow/MCP 后端不存在时 hidden/unavailable；files/add-dir/init 必须影响 context 或打开只读/写入确认流程 |
| Diagnostics / review / safety | status/doctor/review/security/pr-comments/terminal-setup/install-* 必须运行真实检查、生成 prompt、打开外部说明，或在依赖缺失时 disabled 并说明原因 |
| Companion / TUI polish | buddy 系列必须影响 CompanionHandle 或 config；background/logo/debug 只能在有真实 TUI 状态读写时计数 |

---

## 4. 命令来源与适配层

| 来源 | 允许读取位置 | 进入 registry 的方式 | 失败策略 |
|---|---|---|---|
| 内置 slash | `src/cli/slashCommands/**` | `registerSlashCommandsAsPalette()` | duplicate name fail fast |
| SettingsField | `src/screens/settings.tsx` surface | `registerSettingsFieldsAsPalette()` | field 不存在时 toast + 打开 general |
| bundled / project / user skills | `src/skills/registry.ts` + discovery surface | `registerSkillCommandsAsPalette()` | 单个 skill 解析失败不影响其它 skill |
| plugin commands | plugin registry surface | `registerPluginCommandsAsPalette()` | 插件加载失败只 warn/toast |
| workflow commands | workflow registry surface | `registerWorkflowCommandsAsPalette()` | 后端未启用时 hidden，不计数 |
| MCP commands/resources | MCP registry surface | `registerMcpCommandsAsPalette()` | server 不可用时 hidden |

依赖纪律：

- `palette/` 不直接 import `skills/` / `plugins/` / `workflows` / `mcp`。
- `cli/commandSources.ts` 是跨层适配单源。
- HelpOverlay、Ctrl+P、InputBox `/` autocomplete 都读 `listCommands()` / `listSlashes()`。
- Ctrl+P 可以展示 `enabled=false` 并说明原因；`/` autocomplete 只展示当前可执行命令，不展示 hidden / disabled / backend missing 条目。

---

## 5. Skill 覆盖门槛

chovy 保留 CSG（requires / provides / conflicts / budgetTokens）作为差异点。目标不是把 cc-haha skills 平铺照搬，而是把 bundled skill 图扩到足够丰富。

### 必须保留的现有 7 个

| Skill | 要求 |
|---|---|
| `commit` | 保留 conventional commit 指导；必要时 requires `format` |
| `format` | 保留 formatter-safe edit loop |
| `pr` | 保留 PR 准备与摘要 |
| `refactor` | 保留 scoped refactor，必要时 requires `format` |
| `review` | 保留 code review stance |
| `test` | 保留 test selection / execution loop |
| `ts-fix` | 保留 TypeScript error repair，requires `format` |

### Phase L/P 至少新增 8 个，高优先级候选如下

| Skill | 参考来源 | chovy 行为要求 |
|---|---|---|
| `verify` | cc-haha `verify` | 选择最短可证明路径运行 app/smoke/CLI，输出证据 |
| `debug` | cc-haha `debug` | 复现、隔离、补丁、验证，避免盲改 |
| `stuck` | cc-haha `stuck` | 连续失败时收集证据并换策略 |
| `simplify` | cc-haha `simplify` | 降低范围与复杂度，删除偶发抽象 |
| `remember` | cc-haha `remember` | 提议 durable memory 写入，禁止 secrets |
| `skillify` | cc-haha `skillify` | 生成/改进本地 `SKILL.md` |
| `batch` | cc-haha `batch` | 可并行检查/编辑时拆给 sub-agent 或列出并行批次 |
| `update-config` | cc-haha `updateConfig` | 通过安全 config patch 更新配置，必须 strip secret fields |

### 可选 / feature-gated 候选

| Skill | 参考来源 | 计数条件 |
|---|---|---|
| `loop` | cc-haha `loop` | 本地 watch/retry 可用；不需要远端 scheduler |
| `schedule` | cc-haha `scheduleRemoteAgents` | 只有 automation/调度能力存在时计数；否则只作为计划说明 |
| `api-provider` | cc-haha `claude-api` | provider-neutral API 指导，不绑定 Claude-only 文档 |
| `browser-control` | cc-haha `claude-in-chrome` | 只有 browser/chrome connector 存在时可见并计数 |
| `bug-hunt` | cc-haha `hunter` | 系统化回归排查 |
| `ideate` | cc-haha `dream` | 产品/设计/架构备选方案生成 |
| `keybindings` | cc-haha `keybindings` | 若作为 TUI 快捷键诊断 skill，必须不和 settings keybind tab 重复 |
| `skill-generator` | cc-haha `runSkillGenerator` | 只有当本项目允许生成 skill 模板时计数 |

验收线：

- `chovy skill list`、`/skills`、Ctrl+P `Skills` 分类看到同一批 bundled skills。
- 至少 15 个 bundled skills 注册成功，现有 7 个仍在。
- 每个新增 skill 都有 `summary`、`budgetTokens`、CSG metadata；冲突组不互相覆盖。
- skill name 与内置 slash 冲突时，不注册 `/<skill-name>` 便捷入口，只在 picker 中展示。

### 5.1 15 个 bundled skill 的 CSG 元数据基线

下表是 Phase L/P 的最低 bundled skill 图。预算是计划上限，实际 `systemFragment` 仍需控制在 `budgetTokens * 4` 字符左右；总预算必须落在默认 skills context budget 内。

| Skill | requires | provides | conflicts | budgetTokens | 计数条件 |
|---|---|---|---|---:|---|
| `format` | – | `format` | – | 200 | 现有 skill 保留 |
| `commit` | – | `conventional-commits` | `legacy-commits` | 400 | 现有 skill 保留 |
| `pr` | `commit` | `pr-flow` | – | 400 | 现有 skill 保留 |
| `refactor` | `format` | `safe-refactor` | – | 500 | 现有 skill 保留 |
| `review` | – | `code-review` | – | 600 | 现有 skill 保留 |
| `test` | – | `run-tests` | – | 300 | 现有 skill 保留 |
| `ts-fix` | `format` | `typecheck-loop` | – | 600 | 现有 skill 保留 |
| `verify` | `test` | `verification-evidence` | – | 350 | 能规划/运行最短验证路径 |
| `debug` | `verify` | `bug-isolation` | – | 650 | 能复现、隔离、验证修复 |
| `stuck` | – | `strategy-reset` | `loop` | 350 | 能在连续失败后换策略 |
| `simplify` | – | `complexity-reduction` | – | 300 | 能提出删减范围/抽象的路径 |
| `remember` | – | `durable-memory` | – | 250 | 只提议 memory，不写 secrets |
| `skillify` | – | `skill-authoring` | – | 500 | 能生成/改进本地 `SKILL.md` |
| `batch` | – | `parallel-work-plan` | – | 450 | 能列并行批次或调度 sub-agent |
| `update-config` | – | `config-update` | – | 300 | 只能走安全 config patch，必须 strip secrets |

不满足以下任一项时，该 skill 不计入 `bundledSkills`：

- 没有 `triggers`、`summary`、`systemFragment`、`budgetTokens`。
- `requires` 指向不存在 skill。
- `conflicts` 与现有 active skill 冲突时仍能被手动激活。
- `/skills`、Ctrl+P `Skills`、`chovy skill list` 三处数量或 metadata 不一致。

---

## 6. Skill Discovery 来源

发现顺序：

1. Bundled chovy skills：`src/skills/bundled/`。
2. Project skills：`.chovy/skills/**/SKILL.md`。
3. User skills：`~/.chovy/skills/**/SKILL.md`。
4. 只读导入：`.codex/skills/**/SKILL.md`、`.claude/skills/**/SKILL.md`、`.opencode/skills/**/SKILL.md`、`.agents/skills/**/SKILL.md`。
5. 显式路径：`config.skills.paths[]`，相对路径按 cwd 解析，绝对路径原样解析。

Phase L 不做：

- `config.skills.urls[]` 远端下载。
- 自动执行外部 skill 附带脚本。
- 外部 skill 覆盖内置 slash 名称。

远端 skill index 若后续加入，必须另设 `chovy skill install <url>`，含缓存、host allowlist、签名/哈希或用户确认。

---

## 7. TUI / Slash 集成要求

- Ctrl+P `Skills` 分类列出 bundled、project、user、只读导入 skills。
- `/skills` 打开 searchable skill picker。
- `/skill list|show|plan|use|clear|reload|doctor|create` 复用 CSG runtime 与 discovery runtime。
- `/<skill-name> [args]` 只在不冲突时注册；冲突时显示“请用 `/skill use <name>`”。
- InputBox `/` autocomplete 合并 built-in slash、skill commands、plugin commands、workflow commands、MCP commands。
- autocomplete 每项可显示 source label：`builtin` / `settings` / `skill` / `plugin` / `workflow` / `mcp`。
- `CHOVY_NO_PALETTE=1` 只禁 overlay，不禁 `/` autocomplete 与手输 slash。

---

## 8. 并行计划

可并行：

- Skill catalog 扩充可在 Phase J/K 空档推进，不需要 B8。
- Skill discovery source 可与 Phase J、Phase K 并行。
- Command metadata 扩充可在 step-43 草案落地后，与 step-42 搜索评分并行。
- InputBox `/` autocomplete 可在 B8 后与 MessageList / Toast 并行。

必须等待：

- Palette UI 渲染等待 step-41。
- slash autocomplete scoring 等 step-42。
- command count 最终验收等 step-44，因为 slash / settings / skills / plugins / workflows 必须汇总。
- skill coverage 文档最终落地等 step-60，避免 README / USAGE 过早声称未实现行为。

---

## 9. 验收清单

- `scripts/smoke-step43.ts` 输出 `{ commandEquivalents, byGroup, bySource, nonCounted }`，并断言 `commandEquivalents >= 72`。
- `scripts/smoke-step44.ts` 证明 slash-visible commands 覆盖本文所有 group。
- `scripts/smoke-step53.ts` 证明 `/` autocomplete 能找到内置 slash 和至少一个 skill command。
- `chovy skill list`、`/skills`、Ctrl+P `Skills` 分类都显示至少 15 个 bundled skills。
- duplicate command / skill name fail fast，错误信息含冲突来源。
- `CHOVY_NO_PALETTE=1` 时，slash 手输和 `/` autocomplete 仍可用。
- smoke 明确列出“不计数项”，避免 hidden/disabled/TODO 被误算进 72。
