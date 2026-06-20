# Known Limitations

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
