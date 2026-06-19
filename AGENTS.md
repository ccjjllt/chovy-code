## 27. TUI 第二阶段路线图（Phase J–P · step-31..60）

> step-01..30 已构建出能运行的 Bun + Ink REPL；下一阶段把它升级为带**吉祥物 / 命令面板 / 主题 / i18n / 设置界面**的完整 TUI 产品形态。
> **完整路线图 + 不变量**见 `docs/tui/README.md`、`docs/tui/architecture.md`、`docs/tui/innovations.md`、`docs/tui/step-31..60-*.md`。
> 本节只列**跨阶段红线**导航；具体规则见对应 step 文档。

### 阶段划分

| Phase | 范围 | 步骤 | 屏障 |
|---|---|---|---|
| **J** Foundation | 主题 / i18n / Layout / Keybinding / 组件库 | 31–35 | **B8** Theme/Locale/KeyBinding 接口冻结 |
| **K** Mascot | GIF 解码 / 帧缓存 / 状态机 / 集成 / 彩蛋 | 36–40 | **B9** CompanionHandle 冻结 |
| **L** CommandPalette | Ctrl+P 骨架 / 模糊搜索 / 注册 / 集成 | 41–44 | （并行） |
| **M** Welcome & Header v2 | 欢迎屏 / Header chip / Tips | 45–47 | （并行） |
| **N** Settings | 设置骨架 / MiMo 对齐设置域 / wizard 重构 | 48–52 | **B10** SettingsField 冻结 |
| **O** Polish | Input v2 / MessageList / Toast / 动画 / 焦点环 | 53–57 | （并行） |
| **P** Wrap-up | Windows 兼容 / E2E / 文档 | 58–60 | 最终 |

### 跨阶段红线（违反一律拒绝合并）

1. **吉祥物使用 `gif/` 下 5 张真 GIF + 半块字符 ▀▄ 渲染**：参考 `gif/Terminal-GIF-Player-main/play-gif.ps1` 算法；必须保持 GIF 原始配色，默认小尺寸渲染（主屏约 18–22 列，欢迎页不超过 20 列），主题色只影响边框 / 气泡 / 文本，**不**给 GIF 调色或放大；**不**引网络 / 图像处理库 / 在线翻译；**不**抄 cc-haha sprite 数组与 `RARITY_COLORS` / `IDLE_SEQUENCE` / `feature('BUDDY')`。详见 `docs/tui/innovations.md §7 红线 8 处`。
2. **`Ctrl+P` = 命令面板 / `Ctrl+,` = 设置 / `Ctrl+L` = 切语言**：键位单源 = `src/keybindings/defaults.ts`；用户 override 走 `~/.chovy/config.json` 的 `keybindings` 段，**不**写到 secrets/。
3. **默认主题 ChovyDefault**（紫主导 + 蓝辅助；primary 默认 `#7C3AED`，accent 默认 `#3B82F6`）：`primary` / `accent` / `bg` / `fg` / `muted` / `success` / `warning` / `error` / `borderStyle` / `spinnerFrames` 字段冻结（B8）；持久化到 `config.theme.name` + `config.theme.custom` 深合并，用户可自定义颜色，**禁止**进 secrets/。
4. **默认中文，语言设计采用 MiMo 的 preference/effective/label/base/cache/loader 分层**：内部 `Locale = "zh" | "en"`，`LocalePreference = Locale | "auto"`，兼容读取 `zh-CN` / `en-US` alias；新安装默认 `zh`；新加 i18n key 必须 zh + en 同步（CI smoke 校验集合等价）；命令名 / ID 永远英文；不引 i18next / 在线翻译；自实现 `t(key, params?)` + `{{ param }}` 模板解析。
5. **API key 写入路径不变**（§26 既有不变量延伸）：`~/.chovy/secrets/<provider>` 是**唯一**写入位置；config.json 的 zod schema 任何场景下不能含 apiKey/secret 字段；`saveConfigPatch` 必须 `stripSecretFields` 双重保险。
6. **`CHOVY_NO_TUI=1` 顶层兜底**：必须能让 chovy-code 退化到 step-30 既有形态（HeaderBar + MessageList + InputBox），**永远**给用户 escape hatch；与 `CHOVY_NO_SWARM_PANEL` / `CHOVY_NO_COMPANION` / `CHOVY_NO_PALETTE` / `CHOVY_NO_ANIM` 同模式（env 单源，不进 ChovyConfig schema）。
7. **新模块依赖图无环**：
   - `theme/` `i18n/` `keybindings/` `tui/` 是叶子（可被 `companion/` / `palette/` / `screens/` / `cli/` 引用）；
   - `companion/` `palette/` `screens/` 之间**互不**直接 import（跨模块走 `cli/state/` + 进程内 bus）；
   - 新模块**不**反向 import `engine` / `providers` / `agent` / `swarm` / `goals` / `memory` / `context` / `skills`；
   - 与 §17/§18/§20/§21/§22/§23/§24「叶子模块单向依赖」同纪律。
8. **新 telemetry 4 类单源**：`tui.theme.change`（step-31 emit）/ `tui.locale.change`（step-32 emit）/ `tui.palette.exec`（step-43 emit）/ `tui.companion.skin`（step-40 emit）。其它模块**禁止**直发；与 §17/§18/§20/§21/§22/§23 telemetry 单源纪律同模式。
9. **B8 / B9 / B10 接口冻结**：`Theme` / `Locale` / `KeyBinding` / `KeyMatcher` / `CompanionHandle` / `CompanionState` / `CompanionFrame` / `SettingsField` / `SettingsCategory` / `PaletteCommand` 字段名**不改**，扩展只追加可选字段（与 §16 frozen-extension 完全一致）。
10. **Command / Skill 80% 覆盖门槛**：Phase L 验收前必须达到 `docs/tui/command-skill-coverage.md` 的基线：≥72 个 cc-haha 用户可见命令等价行为进入 Ctrl+P / `/` 单源 command store；bundled skills ≥15 且保留 CSG 的 `requires` / `provides` / `conflicts` / `budgetTokens` 图；`palette/` 不直接 import `skills/`，跨层适配只放 `cli/commandSources.ts`。覆盖 smoke 必须输出 `byGroup` / `bySource` / `nonCounted`，hidden / disabled / TODO / backend-missing 条目不得计数。
11. **`queryEngine.ts ≤ 600 行` 硬限继续生效**：TUI 是 UI 层，**不增加**任何 engine 主循环逻辑；新功能放 `cli/` `theme/` `i18n/` `keybindings/` `tui/` `companion/` `palette/` `screens/` 等新目录。
12. **chovy-code TUI 5 项创新**（BUDDY-GIF / PALETTE-CN / THEME-VB / I18N-CN / SMOOTH-3）与既有 5 项后端创新（ATP / SwarmR / TMT / SCW / CSG）**正交**：TUI 是消费方，**不反向**影响 engine / agent / providers / memory / context / skills 内核。
13. **不引入新 npm 依赖**：GIF 解码 / 模糊搜索 / 拼音首字母 / i18n / 主题映射 全部自实现；如必须加（评估后），step 文档「风险」段 + PR 描述里**显式**说明理由 + 大小（与 §8 既有规则一致）。
14. **配置入口三处合一**（§26 延伸）：`chovy config` CLI / REPL `/config` slash / Ctrl+,→Provider/Model tab 复用同一 `runFieldOnce(fieldId, value)` 写入路径（step-52）；外部行为完全不变（`bin/chovy.js` 字节级一致）。
15. **完成报告写入粒度**：只有 Phase 级别完成报告（如 `phase-j-acceptance.md`、`phase-n-acceptance.md`、最终 `phase-j-p-acceptance.md`）可以汇总写入 / 更新 AGENTS.md；单个 step 完成报告只写 `docs/complete/step-XX-acceptance.md` 或对应 step 文档，不得把 step 级流水账追加进 AGENTS.md。

### 工具优先级（§6 沿用）+ 新模块阅读次序

要在 Phase J–P 任一步上动手前先读：

1. `docs/tui/README.md` — 30 步路线 + 依赖安全的并行波次；
2. `docs/tui/architecture.md` — 6 个新模块边界 + 屏障 B8/B9/B10 + 单源规约；
3. `docs/tui/innovations.md` — 5 项 TUI 创新 + 相似但不抄袭边界 + 红线 8 处差异化（必读，避免照搬 cc-haha / mimo）；
4. `docs/tui/command-skill-coverage.md` — 涉及 Ctrl+P、`/`、skills、plugins、workflows 时必读；
5. 自己的 `docs/tui/step-XX-<slug>.md` — 详细产物 / 接口签名 / 验收。

> 不读 `docs/tui/` 直接动手会大概率跑偏——本阶段同样是「先有计划，再有代码」。
