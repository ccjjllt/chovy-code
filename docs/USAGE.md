# Chovy Code USAGE

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
