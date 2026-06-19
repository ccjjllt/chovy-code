# Step 60 — USAGE / DEVELOPING / AGENTS.md / KNOWN-LIMITATIONS 收尾

**Phase**: P | **依赖**: 58, 59 | **估时**: 2h

## 目标

最后一步：把 Phase J–O 全部新功能落进文档；更新 AGENTS.md 现有 TUI 路线章节（§27）；
KNOWN-LIMITATIONS 汇总跨平台 / 已知问题；落 `docs/complete/phase-j-p-acceptance.md` 总验收。

## 产物

```
docs/
├── USAGE.md                                # 用户文档：新增章节
├── DEVELOPING.md                           # 开发者文档：新增章节
├── KNOWN-LIMITATIONS.md                    # 跨平台 / 已知问题
├── tui/known-limitations.md                # TUI 专用（仍存在，做 KNOWN-LIMITATIONS 的引用源）
└── complete/
    ├── phase-j-acceptance.md               # （step-31..35 收尾时落，本步合并引用）
    ├── phase-j-p-acceptance.md             # 整个 TUI 阶段的总验收
    └── step-31..60-acceptance.md (×30)     # 每步落地后写

AGENTS.md                                   # 更新 TUI Phase J/K/L/M/N/O/P 不变量导航
```

## 实现要点

### 1. USAGE.md 新增章节

```md
## 主题与外观

- 默认紫蓝主题 `ChovyDefault`
- `/theme list` 列出全部主题
- `/theme set ChovyHighContrast` 切换
- 设置中可自定义 primary / accent / bg / fg hex 色
- 默认紫色主导、蓝色辅助

## 中英切换

- 默认中文（内部 locale `zh`；兼容旧配置 `zh-CN`）
- `/lang en` 切英文，`/lang auto` 跟随终端语言，`Ctrl+L` 全局快捷键
- 设置中改持久化偏好

## 命令面板

- `Ctrl+P` 打开命令面板
- 支持中英文模糊搜索 + 拼音首字母（locale=`zh`）
- 按 ↑↓ 选择，Enter 执行，Esc 关闭
- 推荐区显示最常用命令（MRU 排序）
- 命令/skills 覆盖矩阵见 `docs/tui/command-skill-coverage.md`；Phase L 验收要求 ≥72 个 cc-haha 等价命令

## 设置界面

- `Ctrl+,` 打开设置（图 4 风格双栏）
- 7 类：常规 / 服务商 / 模型 / 主题 / 语言 / 键位 / 高级
- API key 永远只写到 `~/.chovy/secrets/<provider>`

## 吉祥物

- 默认显示在 InputBox 旁
- `/buddy pet` 或 `Ctrl+B` 摸一下
- `/buddy mute` 静音；`/buddy hide` 隐藏；`/buddy size compact|small|auto` 控制小尺寸；`/buddy skin <name>` 切皮肤
- 5 状态：idle / work / think / done / error
- GIF 保持原色，不跟随主题调色

## Skills

- `chovy skill list` 与 `/skills` 展示同一批 bundled / project / user skills
- Phase L/P 验收要求 bundled skills ≥15，仍保留 CSG 的 requires/provides/conflicts 图
- 用户 skills 放在 `.chovy/skills/**/SKILL.md` 或 `~/.chovy/skills/**/SKILL.md`
- `.codex/.claude/.opencode` skills 可读入但不覆盖 chovy 内置 slash 命令

## 兜底开关（终端兼容）

| 环境变量 | 作用 |
|---|---|
| `CHOVY_NO_TUI=1` | 整个新 TUI 退化到 step-30 形态 |
| `CHOVY_NO_COMPANION=1` | 隐藏吉祥物 |
| `CHOVY_NO_PALETTE=1` | Ctrl+P 走 inline fallback |
| `CHOVY_NO_SWARM_PANEL=1` | 隐藏 SwarmPanel + GoalPanel |
| `CHOVY_NO_ANIM=1` | 禁用所有动画 |
```

### 2. DEVELOPING.md 新增章节

```md
## TUI 模块开发

- 主题：`src/theme/`（紫蓝默认 + 自定义）
- i18n：`src/i18n/`（MiMo 式 `LocalePreference` / base fallback / loader cache / `{{ param }}` template；内置 zh / en）
- 键位：`src/keybindings/`（注册 + 解析 + chord）
- 布局原语：`src/tui/primitives/`
- 组件库：`src/tui/kit/`
- 吉祥物：`src/companion/`（GIF 解码 + ANSI 半块渲染）
- 命令面板：`src/palette/`（含中文模糊搜索）
- 屏幕：`src/screens/`（welcome / settings）

详见 `docs/tui/architecture.md`。

## 新增 i18n key

每加一个 key 必须在 `src/i18n/locales/zh.ts` + `en.ts` 同步；
CI smoke 检验 key 集合等价。

## 新增主题

加在 `src/theme/tokens.ts` 的 `BUILT_INS` 数组；命名 `Chovy<Name>`。

## 新增 palette 命令

调 `registerCommand(...)` 或在 `src/cli/commandSources.ts` 增加来源适配；slash / skills / plugins / workflows 自动进入同一 command store（step-43/44）。
```

### 3. KNOWN-LIMITATIONS.md 汇总（追加章节）

```md
## TUI（Phase J–P）

### 终端兼容
- Windows ConHost 旧版本不支持 24-bit 真彩色；自动降级到 16 色（视觉差异）
- ConHost 在 Ink overlay 切换时可能闪烁；推荐 Windows Terminal，或设 `CHOVY_NO_SWARM_PANEL=1`
- WSL/SSH 转发取决于客户端终端能力

### 吉祥物
- 首次启动需解码 GIF（< 800ms）；后续启动走帧缓存（< 200ms）
- 终端宽度 < 60 列时退化为 ASCII 单行 face
- 终端不支持 Unicode 半块字符 → 退化到 ASCII fallback
- 自定义皮肤需手动放 5 个 `<state>.gif` 到 `~/.chovy/skins/<name>/`，缺一即拒绝切换

### 命令面板
- 拼音首字母仅覆盖 GB2312 一二级常用字（≈ 6700 字）；冷僻字回退原字符匹配
- 多音字按最常见读音
- 搜索结果展示前 50 高分；registry 本身不截断命令

### i18n
- 仅内置 zh / en；兼容读取 zh-CN / en-US；不支持 RTL
- 货币折算汇率写死 7.2，不实时（设置可关闭）
- 切换语言不重启 chovy，但已渲染的 messages 不重写历史（新消息走新 locale）

### 键位
- 不支持录制 chord（Ctrl+X L 这种）；需要手编 config.json
- 录制只支持 modifier+key 单组合
- Ctrl+, 在某些终端被吞掉 → 用户可改 Ctrl+;

### 设置
- API key 输入在 SSH 终端可能仍可见（取决于客户端是否禁用本地回显）
- borderStyle 切换会触发整树重渲染（commit 后才生效）
```

### 4. AGENTS.md TUI 章节更新

加一段简短导航：

```md
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
```

### 5. phase-j-p-acceptance.md

```md
# Phase J–P 总验收

## 范围

step-31 ~ step-60，TUI 第二阶段全部产物。

## 验收命令

- `bun run typecheck`
- `bun run smoke`（含 smoke-tui 30+ 步）
- `bun run demo`（含 5 条新 TUI 主线）
- `bun run bench:tui`（性能基线）

## 检查清单

- [ ] 5 项 TUI 创新已落地（吉祥物 / 命令面板 / 紫蓝主题 / 中英 i18n / 流畅度三件套）
- [ ] 6 个新模块（theme / i18n / keybindings / tui / companion / palette）依赖图无环
- [ ] Welcome / Settings 两个屏幕与 7 类设置域实现完整
- [ ] Command / slash / skills 覆盖矩阵达标：`commandEquivalents >= 72`、bundled skills ≥15，覆盖报告含 `byGroup` / `bySource` / `nonCounted`
- [ ] 15 个 bundled skills 均保留 CSG metadata：`requires` / `provides` / `conflicts` / `budgetTokens`，且三入口数量一致
- [ ] B8 / B9 / B10 接口冻结，字段名不改
- [ ] Windows ConHost / Windows Terminal / Linux / macOS 都能跑
- [ ] CHOVY_NO_TUI=1 退化到 step-30 行为
- [ ] AGENTS.md TUI 不变量已纳入，且只包含 phase 级验收导航
- [ ] USAGE / DEVELOPING / KNOWN-LIMITATIONS 已更新
- [ ] phase-j-acceptance.md 等子阶段验收引用就位
```

## 接口冻结 / 不变量

- 文档结构与既有 `docs/complete/` 同模式；不另开新目录；
- AGENTS.md TUI 章节是路线图导航——具体规则放 docs/tui/，避免 AGENTS.md 膨胀；
- step 级完成报告不得写入 AGENTS.md；只有 phase 级 acceptance 汇总可更新 AGENTS.md；
- KNOWN-LIMITATIONS 章节用「## TUI」分隔，不打散到既有 phase 章节里。

## 验收标准

- 所有上述文档已写入；
- `grep -E '\\bstep-(3[1-9]|[4-5][0-9]|60)\\b' docs/` 返回每个 step 的引用至少 2 处（README + 自身 spec）；
- AGENTS.md typecheck（拼写 / Markdown 格式）无误；
- 文档 PR 评审通过。

## 风险

- **AGENTS.md 膨胀**：TUI 章节只保留跨阶段红线；详细规则放 docs/tui/architecture.md；
- **文档漂移**：每次改 src/theme 或 src/companion 等模块，对应 step 文档「风险」段或 KNOWN-LIMITATIONS 也要更新；
- **i18n 文档**：USAGE.md 默认中文写；维护者可加 USAGE.en.md（不强制，optional）。

## 完结

至此 chovy-code TUI 第二阶段（step-31 ~ step-60，30 步）全部完成。
建议下一阶段（如有）：插件系统 / MCP 集成 / 多会话 tab 等，开 docs/<phase>/ 目录续写。
