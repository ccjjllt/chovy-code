# chovy-code TUI 升级路线图（Phase J–P · 30 步）

> 本文档目录是 chovy-code **TUI 第二阶段**（step-31 ~ step-60）的总体计划。
> step-01 ~ step-30 已构建出能运行的 Bun + Ink REPL 主循环；本阶段把它升级
> 成具备**吉祥物 / 命令面板 / 主题 / i18n / 设置界面**的完整 TUI 产品形态。
>
> 本计划遵循 `docs/README.md` 与 `AGENTS.md` 已建立的「先有计划、再有代码」纪律：
> 每一步有产物清单、接口冻结、验收标准、风险段，**多步可并行**，barrier 处显式同步。
>
> 目录约定：
> - 总体导航：`docs/tui/README.md`（本文）
> - 架构 / 屏障 / 接口冻结点：`docs/tui/architecture.md`
> - 5 项 TUI 创新：`docs/tui/innovations.md`
> - 命令 / skills 覆盖矩阵：`docs/tui/command-skill-coverage.md`
> - **计划评审（对标 claude-code 的优化项 + 测试现状）：`docs/tui/review-claude-code-alignment.md`** ← 动手前必读
> - 每一步详细：`docs/tui/step-31-…md` ~ `docs/tui/step-60-…md`
> - 完工 / 验收报告：`docs/complete/step-XX-acceptance.md`（与既有 step-01~30 同目录）

> ⚠ **2026-06-20 评审摘要**（详见 `review-claude-code-alignment.md`）：
> 1. **测试基线已红**：`bun run demo` 当前在 `main` 上失败（`demo.ts:45` 断言 `8 passed` 已过时，smoke 实为 `12 passed`，已实跑确认）；
>    整套 smoke 只测 CLI 子命令，`architecture.md §7` 禁止渲染 Ink，**整个交互层今天零自动化覆盖**；
>    且 step-45/46/54 验收要求"渲染 snapshot"与 §7 自相矛盾。
> 2. **对标 claude-code 的最大缺口**：后端已具备 `ask_user_question` / `todo_write` / 6 层权限引擎 / 文件 `+/-` diff 追踪，
>    但 step-31..60 **没有为它们做任何 TUI 界面**（`ask_user_question` 在源码里明确等待一个被推迟的 `AskUserOverlay`），
>    却把 5 步投给 GIF 吉祥物。建议重排优先级：先补 AskUserOverlay / 权限审批 / Todo 面板 / Diff 预览，再做装饰。
> 3. InputBox 应补 claude-code 式 `@` 文件引用、`!` bash、生成中状态行+`esc 中断`、busy 消息排队；
>    `/` slash 菜单应与 Ctrl+P 同等优先级。

---

## 1. 设计目标（一句话）

把 chovy-code 的 Ink REPL 升级成「**有吉祥物会动、Ctrl+P 出命令面板、紫蓝主题 + 中文优先**」的完整 TUI，
交互流畅度对标 cc-haha 与 mimo-code，但**审美与组合方式必须是 chovy-code 自己的**——不是镜像。

明确的 5 条不变量：

1. **吉祥物使用 `gif/` 下 5 张真 GIF**（来源 `gif/2026-06-12_*.GIF` + `gif/2026-06-12_234328.GIF`），
   渲染参考 `gif/Terminal-GIF-Player-main/play-gif.ps1` 的算法（半块字符 ▀▄ + ANSI 24-bit 真彩色），保持原始颜色，小尺寸展示。
2. **`Ctrl+P` 打开命令面板**（参考 MiMo 的搜索 / 推荐 / 分类 / 快捷键组织方式，参考 cc-haha 的 slash 覆盖广度，但注册与搜索自实现）。
3. **默认主题 = 紫色主导 + 蓝色辅助**（`ChovyDefault`，`primary=#7C3AED violet-600`、`accent=#3B82F6 blue-500`），
   可运行时切换 + 自定义颜色 + `~/.chovy/config.json` 持久化。
4. **默认语言 = 中文（内部 `zh`，兼容 `zh-CN` alias）**，语言状态参考 MiMo 的 `preference/effective/label/base/cache/loader` 分层；`Ctrl+L`、`/lang` 或设置界面切换中英；
   翻译走 dictionary，**不接入任何在线翻译服务**。
5. **不抄 cc-haha / mimo**：见 `innovations.md §6/§7 差异化清单`——禁止照搬 SpeechBubble 边框形状、
   命令面板配色、CompanionSprite 状态机字段名。

---

## 2. 参考对齐修订（MiMo / cc-haha）

本轮计划只吸收参考项目的产品结构，不复制实现：

- **语言**：采用 MiMo TUI 的 `LocalePreference = Locale | "auto"`、`effectiveLocale`、`INTL`、`LABEL_KEY`、`labelLocale()`、base fallback、loader/cache、`{{ param }}` 模板设计；chovy 新安装仍默认中文，命令名 / provider / model / keybinding ID 永远英文。
- **设置**：Ctrl+, 设置页对齐 MiMo 的域划分，扩成 `general` / `provider` / `model` / `theme` / `language` / `keybind` / `advanced` 7 类；其中声音、桌面字体等不适合纯 TUI 的项不搬，改成终端可实现的 toast、提示、工具块、动画、compact density 等选项。
- **命令**：Ctrl+P 与 `/` 共用 MiMo 式 command store；参考 MiMo 的 suggested/hidden/enabled/slash 语义，参考 cc-haha 的命令覆盖面，Phase L 验收要求 ≥72 个 cc-haha 等价命令（见 `command-skill-coverage.md`）。
- **Skills**：保留 chovy 的 CSG 图，不退回平铺技能；参考 cc-haha/MiMo 补齐内置 skill 目录与 SKILL.md 发现来源，Phase L/P 验收要求 ≥15 个 bundled skills，且 `/skills` / Ctrl+P / `/skill` 共用同一发现结果。
- **整体 TUI**：操作密度、可发现性、快捷键覆盖和诊断入口对齐 cc-haha 的丰富度；布局、主题、吉祥物、气泡、命令分组和状态命名保持 chovy-code 自己的产品语言。
- **吉祥物**：只使用 chovy `gif/` 真 GIF，保持原色与小尺寸；cc-haha 的 hatch/release/rarity/sprite 数组不进入 chovy 计划。
- **主题**：默认紫色占主要视觉权重，蓝色只作辅助 focus / action；Settings 与 `/theme` 都能改 `primary` / `accent` / `bg` / `fg` / `borderStyle` 等 `theme.custom` 字段。

### 2.1 操作丰富度对齐清单

TUI 可以参考 cc-haha 的操作密度，但不复制其 UI 文案、边框、吉祥物与命令实现。验收看下面这些能力是否同时存在：

| 维度 | cc-haha 给出的参考强度 | chovy 计划要求 |
|---|---|---|
| Slash 覆盖 | 大量 session / config / model / review / plugin / skill 命令 | Phase L `commandEquivalents >= 72`，并覆盖 `command-skill-coverage.md` 8 个 group |
| Ctrl+P 可发现性 | 命令、skills、设置、快捷键集中搜索 | MiMo 式 command store：`suggested` / `hidden` / `enabled` / `slash` 单源，空 query 有推荐与 MRU |
| 输入操作 | slash hint、历史、粘贴、编辑器入口 | step-53 必须支持 `/` autocomplete、Tab 补全、history、paste detect、draft 保留 |
| 设置操作 | provider/model/theme/keybinding 都可调 | Ctrl+, 7 分类；字段可搜索；设置项能注册为 palette command |
| Skills | bundled、project、user、外部目录发现 | bundled skills ≥15；`chovy skill list`、`/skills`、Ctrl+P `Skills` 同源 |
| 诊断与安全 | doctor/status/review/security 等入口 | diagnostics group 至少包含 status/doctor/review/security/pr/feedback/terminal/setup 等可执行入口 |
| 消息与工具块 | 工具调用、diff、cost、usage 可浏览 | step-54/46 展示 tool call、折叠、成本、上下文、usage/status chips |
| 降级与兜底 | remote/safe mode、禁用动画/面板 | `CHOVY_NO_TUI` / `CHOVY_NO_PALETTE` / `CHOVY_NO_COMPANION` / `CHOVY_NO_ANIM` 均可单独生效 |

这张表是 UI 丰富度的验收入口：只完成视觉框架但没有命令、设置、skills、诊断、输入补全，不算达到 cc-haha 级别的操作性。

---

## 3. 路线图全貌（30 步 · 7 Phase）

| Phase | 范围 | 步骤 | 产物形态 | 估时合计 | 屏障终点 |
|---|---|---|---|---|---|
| **J — Foundation** | 主题 / i18n / Layout / 键位 / 组件库 | 31–35 | TUI 基础设施 | 18h | **B8** 主题 + i18n + 键位 API 冻结 |
| **K — Mascot** | GIF→ANSI / 帧缓存 / 状态机 / 集成 / 彩蛋 | 36–40 | 跑动的吉祥物组件 | 17h | **B9** Companion API 冻结 |
| **L — CommandPalette** | 骨架 / 搜索 / 注册 / 命令+skills 覆盖 / 集成 | 41–44 + 横向 CSG-R | Ctrl+P 命令面板 + 80% 覆盖门槛 | 14h + 6h | （并行） |
| **M — Welcome & Header v2** | 欢迎屏二栏 / Header / Tips | 45–47 | 启动屏 + 顶栏 | 8h | （并行） |
| **N — Settings** | 设置骨架 / MiMo 对齐设置域 / wizard 重构 | 48–52 | Ctrl+, 设置界面 | 18h | **B10** Settings API 冻结 |
| **O — Polish** | Input v2 / MessageList / Toast / 动画 / 焦点 | 53–57 | 流畅度兜底 | 14h | （并行） |
| **P — Wrap-up** | Windows 兼容 / E2E / 文档 | 58–60 | 验收 + 发布 | 7h | 最终 |

**合计**：约 102h（含命令/skills 覆盖横向任务）；按 5 worker 并行执行预估 24-29h 落地。

### Step 并行 / 串行速查表

| Phase / 区间 | 可并行 step | 必须串行 / 等待 step | 说明 |
|---|---|---|---|
| **J — Foundation** | 31 / 32 / 33 可同时启动；34 与 35 可并行收尾 | 34 必须等 33；35 必须等 31+32+33；31–35 全部完成后形成 **B8** | B8 冻结 Theme / Locale / KeyBinding，是 K–O 的公共前置 |
| **K — Mascot** | 36 可与 41 / 46 / 48 / 53 / 54 / 55 并行；40 可与 45 并行 | Mascot 内部主链为 36 → 37 → 38 → 39 → 40 | 45 只等到 39 可嵌入吉祥物，不必等待 40 偏好命令 |
| **L — CommandPalette** | 42 与 43 可并行；CSG-R skill catalogue 可并行推进 | 41 → (42 + 43) → 44；44 必须等命令 / skills 覆盖门槛 | `commandEquivalents >= 72` 是 44 验收硬门槛 |
| **M — Welcome & Header v2** | 45 与 46 在各自依赖满足后可并行 | 45+46 → 47；45 必须等 step-39，46 只等 B8 | Welcome 用吉祥物，Header 只依赖主题 / i18n / layout |
| **N — Settings** | 49 / 50 / 51 可并行 | 48 → (49 + 50 + 51) → 52 → **B10** | B10 冻结 SettingsField / SettingsCategory |
| **O — Polish** | 53 / 54 / 55 可并行 | 55 → 56；39+44+52 → 57 | 57 是跨 overlay 焦点整合，必须等 companion / palette / settings 都落地 |
| **P — Wrap-up** | 58 与 59 可并行 | 58+59 → 60 | 60 只做最终文档与 Phase 级验收汇总 |
| **横向 CSG-R** | skill catalog 可在 Phase J/K 空档推进；command metadata 可在 43 后与 44 并行补齐 | 最终计数必须等 44 汇总 slash / settings / skills / plugins / workflows | 不新增 step 编号，但阻塞 Phase L 验收 |

---

## 4. 步骤索引表

> 每一行指向 `docs/tui/step-XX-<slug>.md`。「依赖」是显式 barrier，「可并行」=
> 列出可与本步并发的兄弟步骤。Phase J 是公共依赖，所有后续步骤均隐式依赖完整 J。

### Phase J — Foundation（5 步 · 18h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 31 | [TUI 主题系统：紫蓝默认 + 自定义 + 持久化](./step-31-theme-system.md) | step-02 (config) | 32, 33 | 4h |
| 32 | [i18n 中英双语：dictionary + Provider + /lang](./step-32-i18n.md) | step-02 (config) | 31, 33 | 4h |
| 33 | [Layout primitives + 终端能力探测](./step-33-layout-primitives.md) | step-05 (REPL) | 31, 32 | 3h |
| 34 | [Keybinding 注册中心（Ctrl+P / Ctrl+L / Ctrl+, 等）](./step-34-keybinding-registry.md) | 33 | 35 | 4h |
| 35 | [TUI 基础组件库（Panel/Card/Badge/Spinner/Divider）](./step-35-component-kit.md) | 31, 32, 33 | 34 | 3h |

**B8 屏障**：`Theme` / `Locale` / `KeybindingRegistry` 接口冻结，`step-XX-acceptance` 落 `phase-j-acceptance.md`。

### Phase K — Mascot（5 步 · 17h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 36 | [GIF 解码 + ANSI 半块渲染核心](./step-36-gif-ansi-renderer.md) | B8 | 41, 46, 48, 53, 54, 55 | 4h |
| 37 | [帧缓存 + Companion 播放器组件](./step-37-companion-player.md) | 36 | – | 3h |
| 38 | [5 个吉祥物状态机（idle/work/think/done/error）](./step-38-companion-state-machine.md) | 37 | – | 4h |
| 39 | [Companion 集成主屏 + speech bubble](./step-39-companion-integration.md) | 38 | 42, 43, 49, 50, 51 | 3h |
| 40 | [Companion 偏好 / `/buddy` 命令 / 静音 / 彩蛋](./step-40-companion-prefs.md) | 39 | 45 | 3h |

**B9 屏障**：`CompanionHandle` / `CompanionFrame` / `CompanionState` 冻结。

### Phase L — Command Palette（4 步 · 14h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 41 | [CommandPalette 骨架（Ctrl+P / overlay / 焦点）](./step-41-palette-skeleton.md) | B8 | 36, 46, 48, 53, 54, 55 | 4h |
| 42 | [模糊搜索 + 中文分词 + 高亮](./step-42-palette-fuzzy-search.md) | 41 | – | 3h |
| 43 | [命令注册中心（推荐 / 分类 / 快捷键映射）](./step-43-palette-registry.md) | 41 | 42 | 4h |
| 44 | [集成既有 slash + 配置项 + 跳转设置](./step-44-palette-integration.md) | 42, 43 | – | 3h |

**横向 CSG-R（不新增 step 编号）**：命令 / skills 覆盖补齐。它触达 `src/skills/`、`src/cli/slashCommands/`、`src/palette/` 的注册适配层，可与 41/42 并行，但必须在 44 验收前完成；具体清单见 `command-skill-coverage.md`。

### Phase M — Welcome & Header v2（3 步 · 8h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 45 | [WelcomeScreen 二栏布局（吉祥物 + Tips）](./step-45-welcome-screen.md) | B8 + step-39 | 40, 49, 50, 51 | 3h |
| 46 | [HeaderBar v2 chip 系统 + 主题接入](./step-46-header-v2.md) | B8 | 36, 41, 48 | 3h |
| 47 | [启动 Tips + 新手引导 + 版本提示](./step-47-tips-and-onboarding.md) | 45, 46 | – | 2h |

### Phase N — Settings（5 步 · 18h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 48 | [SettingsScreen 骨架（MiMo 风格左右双栏 + 7 分类）](./step-48-settings-screen.md) | B8 | 36, 41, 46, 53, 54, 55 | 4h |
| 49 | [General + Provider + Model 设置分类](./step-49-settings-general-provider.md) | 48 | 50, 51 | 4h |
| 50 | [Theme/Appearance + Language 设置](./step-50-settings-theme-language.md) | 48 | 49, 51 | 4h |
| 51 | [Keybindings 设置 + 冲突检测](./step-51-settings-keybindings.md) | 48 | 49, 50 | 3h |
| 52 | [重构 ConfigWizard ↔ SettingsScreen 共享逻辑](./step-52-wizard-refactor.md) | 49, 50, 51 | – | 3h |

**B10 屏障**：`SettingsField` / `SettingsCategory` 冻结。

### Phase O — Polish（5 步 · 14h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 53 | [InputBox v2（多行 / 历史 / 补全 hint / paste 检测）](./step-53-input-box-v2.md) | B8 | 54, 55 | 3h |
| 54 | [MessageList 虚拟化 + 折叠 + 工具调用块](./step-54-message-list.md) | B8 | 53, 55 | 3h |
| 55 | [Notification / Toast 系统](./step-55-toast-system.md) | B8 | 53, 54 | 2h |
| 56 | [Micro-animations（spinner / fade / slide）](./step-56-micro-animations.md) | 55 | – | 3h |
| 57 | [全局焦点环 v2（input ↔ palette ↔ settings ↔ swarm ↔ goal ↔ companion）](./step-57-focus-ring.md) | 39, 44, 52 | – | 3h |

### Phase P — Wrap-up（3 步 · 7h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 58 | [Windows ConHost 兼容 + 性能压测](./step-58-windows-perf.md) | O 全部 | 59 | 3h |
| 59 | [TUI E2E smoke + bench + demo 更新](./step-59-tui-e2e.md) | O 全部 | 58 | 2h |
| 60 | [USAGE / DEVELOPING / AGENTS.md / KNOWN-LIMITATIONS 收尾](./step-60-docs-final.md) | 58, 59 | – | 2h |

---

## 5. 可并行任务与 5-worker 调度

**依赖安全的并行波次**：

| 波次 | 可并行任务 | 必须等待 |
|---|---|---|
| Wave 1 | 31 theme、32 i18n、33 layout | step-02 / step-05 既有基础 |
| Wave 2 | 34 keybinding、35 component-kit | 34 等 33；35 等 31/32/33 |
| B8 后 Wave 3 | 36 mascot decoder、41 palette skeleton、46 header、48 settings skeleton、53 input、54 message、55 toast | B8 |
| Wave 4 | 42 fuzzy 与 43 registry 并行；49/50/51 设置分类并行；37→38→39 mascot 串行推进 | 41、48、36 分别完成 |
| Wave 5 | 40 buddy prefs 与 45 welcome 并行；44 palette integration 等 42/43；CSG-R 命令/skills 覆盖可在 43 后并行推进；52 wizard 等 49/50/51；56 animation 等 55 | 39 / 42+43 / 49+50+51 / 55 |
| Wave 6 | 47 tips、57 focus ring | 47 等 45+46；57 等 39+44+52 |
| Wave 7 | 58 Windows perf 与 59 E2E 并行 | O 全部完成 |
| Final | 60 文档收尾 | 58+59 |

**建议 5-worker 分配**（worker 内仍遵守上表依赖，空档可帮同波次任务评审）：

```text
Worker 1 (foundation/theme/i18n):     31 → 32 review → 35 → 50 → 56
Worker 2 (layout/keybind/header):     33 → 34 → 46 → 47 → 57
Worker 3 (mascot pipeline):           36 → 37 → 38 → 39 → 40 → 45
Worker 4 (palette/slash):             41 → 42 → 43 → CSG-R command metadata → 44 → 53
Worker 5 (settings/skills/wrap-up):    48 → 49 → CSG-R skill catalogue → 51 → 52 → 54 → 55 → 58/59 → 60
```

**硬性 barrier**：

- **B8（J 收尾）**：31–35 全部完成后，才允许 K/L/M/N/O 中依赖 B8 的任务启动。
- **B9（K 收尾）**：36–40 完成后冻结 Companion API；但 45 只需等到 39 可嵌入 GIF，不必等 40 的偏好命令。
- **B10（N 收尾）**：52 完成后冻结 Settings API；57 接入 Settings 焦点必须等 B10。
- **最终**：60 只能在 58 和 59 都完成后执行；Phase 级验收报告可汇总进 AGENTS，step 级报告不得追加进 AGENTS。
- **覆盖门槛**：step-44 不能在 `commandEquivalents >= 72` 前验收；覆盖 smoke 必须输出 `byGroup` / `bySource` / `nonCounted`，hidden / disabled / TODO / backend-missing 不计数；step-60 不能在 bundled skills ≥15 且 README/USAGE/DEVELOPING 写清真实可用范围前验收。

---

## 6. 与既有 chovy-code 不变量的关系

本 TUI 阶段**严格遵守** AGENTS.md §1–§26 全部不变量。重点关注：

- **AGENTS.md §16/§17 单源规约**：theme / locale / keybinding / palette command 都必须有**单一权威**模块；
  下游 re-export，禁止重声明 union（与 `MemoryLayer` / `HookEvent` 同纪律）。
- **AGENTS.md §17 `queryEngine.ts ≤ 600 行` 硬限**：本阶段**不增加** queryEngine.ts 行数；
  TUI 是 UI 层，不进 engine。
- **AGENTS.md §22/§23 `CHOVY_NO_SWARM_PANEL` 同模式**：新增 `CHOVY_NO_COMPANION` / `CHOVY_NO_PALETTE`
  作为 Windows ConHost 闪烁兜底开关，env 单源（不进 ChovyConfig schema）。
- **AGENTS.md §26 配置入口不变量**：API key 仍**只**写 `~/.chovy/secrets/<provider>`；
  设置界面修改 model / theme / locale / keybinding 写 `config.json`，**绝不**触碰 secrets。
- **AGENTS.md §9 红线**：TUI 不引入网络字体 / 在线翻译 / 自动上传任何素材；
  GIF 帧解码全部本地完成（参考 `gif/Terminal-GIF-Player-main` 的算法）。

---

## 7. 阅读顺序（给即将动手的 agent）

1. 读完本 README §1-§6；
2. 读 `docs/tui/review-claude-code-alignment.md`（对标 claude-code 的优化项 + 测试现状，**优先级最高**）；
3. 读 `docs/tui/architecture.md`，理解核心新模块（`theme/` `i18n/` `keybindings/` `tui/` `companion/` `palette/` `screens/`）
   与既有 `cli/` 的依赖边和 barrier 时点；
4. 读 `docs/tui/innovations.md`，知道哪些是 chovy-code 自己的设计、哪些必须避免照搬；
5. 若任务涉及命令、slash、skills、InputBox 补全，读 `docs/tui/command-skill-coverage.md`；
6. 找到自己的 step 文档，**严格按产物清单 + 接口签名**实现；
7. 收尾跑该 step 的「验收标准」冒烟，落 `docs/complete/step-XX-acceptance.md`。

> **不读 docs/tui 直接动手会大概率跑偏**——本阶段同样是「先有计划，再有代码」。
