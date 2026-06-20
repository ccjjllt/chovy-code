# KNOWN-LIMITATIONS (TUI Phase P)

本阶段汇总的已知限制，最终将合并到根目录 `docs/KNOWN-LIMITATIONS.md` 中。

## Windows 终端兼容性

1. **Windows ConHost (新/旧) 支持限制**
   - **颜色降级**：旧版 ConHost 只有 16 色，新版 ConHost 仅有部分 24-bit TrueColor 支持。使用默认高对比度色值（如 `#7C3AED` 紫色）在未开启 24-bit 颜色时会被系统映射为相近颜色。
   - **动画闪烁**：因为 ConHost 无法实现高性能无闪烁的重绘（缺乏双缓冲支持和优化的 ANSI 渲染引擎），导致 `SwarmPanel` 这种高频刷新的组件会发生明显闪烁。
   - **推荐方案**：我们会在检测到 `isConHost && !trueColor` 时，弹窗建议用户使用 Windows Terminal。用户也可以设置环境变量 `CHOVY_NO_SWARM_PANEL=1` 或 `CHOVY_NO_ANIM=1` 进行性能回退。在最极端的旧版系统上，可使用 `CHOVY_NO_TUI=1` 退回无侧边栏的基础形态（即 step-30 形式）。

2. **WSL (Windows Subsystem for Linux)**
   - `process.platform === "linux"` 会在 WSL 中触发，但其宿主终端可能是 ConHost，这也可能导致颜色或闪烁异常。此时检测逻辑通过 `/proc/version` 中的 `Microsoft` 字样判断是否运行于 WSL，进而同样建议切换到 Windows Terminal。

## 性能限制

1. **首次 GIF 解码延迟**
   - 因为我们使用纯终端 ANSI 输出字符画还原 GIF（没有引入外部二进制图像库），且采用字符缓存架构，第一次展示前需要经过解析与生成。冷启动首屏通常耗时 ~800ms，之后热启动直接读取序列化缓存，可降至 ~200ms。如果在部分低端机器上缓存生成仍长于 1.5s，这符合预期设计上限。
   - 内存长期占用：在 `scripts/perf-tui.ts` 压测中控制在 ~150MB。

2. **其它**
   - 目前终端组件只保证在 `cols >= 80` 且 `rows >= 24` 时有最佳体验。若终端过窄（小于 60 列），`SwarmPanel` 与 `CompanionHost` 可能发生重叠截断，这属于设计折衷，请放大终端尺寸。
