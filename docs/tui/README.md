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
> - 每一步详细：`docs/tui/step-31-…md` ~ `docs/tui/step-60-…md`
> - 完工 / 验收报告：`docs/complete/step-XX-acceptance.md`（与既有 step-01~30 同目录）

---

## 1. 设计目标（一句话）

把 chovy-code 的 Ink REPL 升级成「**有吉祥物会动、Ctrl+P 出命令面板、紫蓝主题 + 中文优先**」的完整 TUI，
交互流畅度对标 cc-haha 与 mimo-code，但**审美与组合方式必须是 chovy-code 自己的**——不是镜像。

明确的 5 条不变量：

1. **吉祥物使用 `gif/` 下 5 张真 GIF**（来源 `gif/2026-06-12_*.GIF` + `gif/2026-06-12_234328.GIF`），
   渲染参考 `gif/Terminal-GIF-Player-main/play-gif.ps1` 的算法（半块字符 ▀▄ + ANSI 24-bit 真彩色）。
2. **`Ctrl+P` 打开命令面板**（图 4 mimo 风格：搜索 / 推荐 / 分类 / 高亮当前 / 右侧快捷键）。
3. **默认主题 = 紫色 + 蓝色**（`ChovyDefault`，`primary=#8B5CF6 violet-500`、`accent=#3B82F6 blue-500`），
   可运行时切换 + `~/.chovy/config.json` 持久化。
4. **默认语言 = 中文（zh-CN）**，`Ctrl+L` 或设置界面切换中英；翻译走 dictionary，**不接入任何在线翻译服务**。
5. **不抄 cc-haha / mimo**：见 `innovations.md §6 差异化清单`——禁止照搬 SpeechBubble 边框形状、
   命令面板配色、CompanionSprite 状态机字段名。

---

## 2. 路线图全貌（30 步 · 7 Phase）

| Phase | 范围 | 步骤 | 产物形态 | 估时合计 | 屏障终点 |
|---|---|---|---|---|---|
| **J — Foundation** | 主题 / i18n / Layout / 键位 / 组件库 | 31–35 | TUI 基础设施 | 18h | **B8** 主题 + i18n + 键位 API 冻结 |
| **K — Mascot** | GIF→ANSI / 帧缓存 / 状态机 / 集成 / 彩蛋 | 36–40 | 跑动的吉祥物组件 | 17h | **B9** Companion API 冻结 |
| **L — CommandPalette** | 骨架 / 搜索 / 注册 / 集成 | 41–44 | Ctrl+P 命令面板 | 14h | （并行） |
| **M — Welcome & Header v2** | 欢迎屏二栏 / Header / Tips | 45–47 | 启动屏 + 顶栏 | 8h | （并行） |
| **N — Settings** | 设置骨架 / 4 分类 / wizard 重构 | 48–52 | Ctrl+, 设置界面 | 16h | **B10** Settings API 冻结 |
| **O — Polish** | Input v2 / MessageList / Toast / 动画 / 焦点 | 53–57 | 流畅度兜底 | 14h | （并行） |
| **P — Wrap-up** | Windows 兼容 / E2E / 文档 | 58–60 | 验收 + 发布 | 7h | 最终 |

**合计**：约 94h；按 5 worker 并行执行预估 22-26h 落地。

---

## 3. 步骤索引表

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
| 36 | [GIF 解码 + ANSI 半块渲染核心](./step-36-gif-ansi-renderer.md) | B8 | 41, 45, 48 | 4h |
| 37 | [帧缓存 + Companion 播放器组件](./step-37-companion-player.md) | 36 | – | 3h |
| 38 | [5 个吉祥物状态机（idle/work/think/done/error）](./step-38-companion-state-machine.md) | 37 | – | 4h |
| 39 | [Companion 集成主屏 + speech bubble](./step-39-companion-integration.md) | 38 | 41, 45 | 3h |
| 40 | [Companion 偏好 / `/buddy` 命令 / 静音 / 彩蛋](./step-40-companion-prefs.md) | 39 | – | 3h |

**B9 屏障**：`CompanionHandle` / `CompanionFrame` / `CompanionState` 冻结。

### Phase L — Command Palette（4 步 · 14h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 41 | [CommandPalette 骨架（Ctrl+P / overlay / 焦点）](./step-41-palette-skeleton.md) | B8 | 36, 45, 48 | 4h |
| 42 | [模糊搜索 + 中文分词 + 高亮](./step-42-palette-fuzzy-search.md) | 41 | – | 3h |
| 43 | [命令注册中心（推荐 / 分类 / 快捷键映射）](./step-43-palette-registry.md) | 41 | 42 | 4h |
| 44 | [集成既有 slash + 配置项 + 跳转设置](./step-44-palette-integration.md) | 42, 43 | – | 3h |

### Phase M — Welcome & Header v2（3 步 · 8h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 45 | [WelcomeScreen 二栏布局（吉祥物 + Tips）](./step-45-welcome-screen.md) | B8 + step-39 | 48 | 3h |
| 46 | [HeaderBar v2 chip 系统 + 主题接入](./step-46-header-v2.md) | B8 | 45 | 3h |
| 47 | [启动 Tips + 新手引导 + 版本提示](./step-47-tips-and-onboarding.md) | 45, 46 | – | 2h |

### Phase N — Settings（5 步 · 16h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 48 | [SettingsScreen 骨架（mimo 风格左右双栏）](./step-48-settings-screen.md) | B8 | 36, 41, 45 | 4h |
| 49 | [General + Provider 设置分类](./step-49-settings-general-provider.md) | 48 | 50, 51 | 3h |
| 50 | [Theme + Language 设置](./step-50-settings-theme-language.md) | 48 | 49, 51 | 3h |
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
| 57 | [全局焦点环 v2（input ↔ palette ↔ settings ↔ swarm ↔ goal ↔ companion）](./step-57-focus-ring.md) | 39, 44, 48 | – | 3h |

### Phase P — Wrap-up（3 步 · 7h）

| 步 | 标题 | 依赖 | 可并行 | 估时 |
|---|---|---|---|---|
| 58 | [Windows ConHost 兼容 + 性能压测](./step-58-windows-perf.md) | O 全部 | 59 | 3h |
| 59 | [TUI E2E smoke + bench + demo 更新](./step-59-tui-e2e.md) | O 全部 | 58 | 2h |
| 60 | [USAGE / DEVELOPING / AGENTS.md / KNOWN-LIMITATIONS 收尾](./step-60-docs-final.md) | 58, 59 | – | 2h |

---

## 4. 5-worker 并行调度建议

> 同 `docs/README.md §并行计划`，每个 worker 拿一组互不阻塞的步骤。

```
Worker 1 (theme/i18n/component):     31 → 32 → 35 → 50 → 51 → 56
Worker 2 (layout/keybind/header):    33 → 34 → 46 → 47 → 53 → 57
Worker 3 (mascot pipeline):          36 → 37 → 38 → 39 → 40 → 45
Worker 4 (palette + settings):       41 → 42 → 43 → 44 → 48 → 49 → 52
Worker 5 (polish + wrap-up):         54 → 55 → 58 → 59 → 60
```

**Barrier 规则**：

- **B8（J 收尾）**：worker 1+2+3 必须先收敛到 step-35 完成；worker 3/4/5 才能各自启动 K/L/N。
- **B9（K 收尾）**：worker 3 step-39 完成后，worker 3 才能开 step-45（welcome 嵌吉祥物）。
- **B10（N 收尾）**：worker 4 step-52 完成后，worker 5 step-57 才能接入 SettingsScreen 焦点。
- **最终**：P 阶段 3 步必须串行，且必须等 O 全部完成。

---

## 5. 与既有 chovy-code 不变量的关系

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

## 6. 阅读顺序（给即将动手的 agent）

1. 读完本 README §1-§5；
2. 读 `docs/tui/architecture.md`，理解 5 个新模块（`theme/` `i18n/` `keybindings/` `companion/` `palette/`）
   与既有 `cli/` 的依赖边和 barrier 时点；
3. 读 `docs/tui/innovations.md`，知道哪些是 chovy-code 自己的设计、哪些必须避免照搬；
4. 找到自己的 step 文档，**严格按产物清单 + 接口签名**实现；
5. 收尾跑该 step 的「验收标准」冒烟，落 `docs/complete/step-XX-acceptance.md`。

> **不读 docs/tui 直接动手会大概率跑偏**——本阶段同样是「先有计划，再有代码」。
