## 27. TUI 第二阶段路线图（Phase J–P · step-31..60）

> 完整路线 + 不变量见 `docs/tui/README.md`、`docs/tui/architecture.md`、`docs/tui/innovations.md`。
> 本节只列**跨阶段红线**；具体规则见对应 step 文档。

- **吉祥物使用 `gif/` 下 5 张真 GIF + 半块字符渲染**；保持原色、小尺寸；不引网络 / 不引图像库；不抄 cc-haha sprite 数组。
- **`Ctrl+P` 命令面板 / `Ctrl+,` 设置 / `Ctrl+L` 切语言**；键位单源 = `src/keybindings/defaults.ts`。
- **默认主题 ChovyDefault（紫 #7C3AED 主导 + 蓝 #3B82F6 辅助）**；持久化到 `~/.chovy/config.json` 的 theme 段。
- **默认中文（`zh`）**；语言状态采用 MiMo 式 `LocalePreference` / effective locale / base fallback / loader cache 分层；新加 i18n key 必须 zh + en 同步（CI smoke 校验）。
- **Settings 对齐 MiMo 信息架构**：general/provider/model/theme/language/keybind/advanced 7 类，但只保留 TUI 可实现项。
- **Slash/Palette 对齐 MiMo + cc-haha 覆盖面**：命令 registry 单源，Phase L 验收 ≥72 个 cc-haha 等价命令；bundled skills ≥15。
- **API key 永远只写 `~/.chovy/secrets/<provider>`**（AGENTS.md §26 既有不变量延伸）。
- **`CHOVY_NO_TUI=1` 顶层兜底**：能让所有新功能退化到 step-30 形态。
- **新模块依赖图无环**：`theme/i18n/keybindings/tui` 是叶子；`companion/palette/screens` 互不依赖。
- **新 telemetry 4 类**（`tui.theme.change` / `tui.locale.change` / `tui.palette.exec` / `tui.companion.skin`）单源。
- **B8 / B9 / B10 屏障接口冻结**：`Theme` / `Locale` / `KeyBinding` / `CompanionHandle` / `SettingsField`
  字段名不改，扩展只追加可选字段（与 §16/§17/§18/§20/§21/§22/§23/§24 同纪律）。
- **chovy-code TUI 创新 5 项**（BUDDY-GIF / PALETTE-CN / THEME-VB / I18N-CN / SMOOTH-3）与既有 5 项后端
  创新（ATP / SwarmR / TMT / SCW / CSG）**正交**；TUI 是消费方，不反向影响 engine。
- **完成报告写入粒度**：只有 phase 级验收报告能汇总进 AGENTS.md；step 级报告只写 docs/complete，不追加 AGENTS。
