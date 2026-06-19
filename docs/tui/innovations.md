# chovy-code TUI 5 项创新

> 配合 `docs/tui/README.md` + `docs/tui/architecture.md` 阅读。
> 本文回答两个问题：① **本阶段我们到底有什么自己的设计**；② **哪些必须避免照搬 cc-haha / mimo**。

---

## 1. 创新 #1：BUDDY-GIF — 真 GIF 驱动的吉祥物（不是 ASCII sprite）

### 设计

cc-haha 的 `CompanionSprite` 是 **手画 ASCII sprite**（`src/buddy/sprites.ts`）+ 帧索引切换；
chovy-code 反其道：**直接用真 GIF 文件**，运行时解码每一帧 → ANSI 半块字符串 → Ink `<Text>` 输出。

> ⚠ **评审注记（投入再平衡 · 详见 `review-claude-code-alignment.md §2.2`）**：
> 吉祥物是 chovy 的差异化亮点，但 step-36..40 共 **5 步 ~17h** 的投入相对 claude-code 体验目标偏重——
> claude-code 是极简、信息密集的专业工具，没有吉祥物。建议：
> - 将吉祥物**压缩为 2–3 步**（解码+渲染合并、播放器+状态机合并、集成），把省下的预算转给
>   AskUserOverlay / 权限审批 / Todo 面板 / Diff 预览（后端已就绪、却无 UI——见 §2.1）；
> - 默认更克制：**欢迎屏可有 GIF，主屏常驻 companion 改为 opt-in**（默认仅 busy/done/error 短暂提示）；
> - 吉祥物**不应排在协作交互面之前**。

技术细节（详见 `step-36`）：

- 解码：Bun 内置 `Bun.file().arrayBuffer()` 读 GIF → 自实现 GIF block parser + LZW 解码 → ARGB 帧序列。
- 渲染：参考 `gif/Terminal-GIF-Player-main/play-gif.ps1` 的算法 ——
  ```
  每 2 行像素合并为 1 行终端字符
    上半像素 → 前景色 (▀ U+2580)
    下半像素 → 背景色
  ANSI 24-bit:  ESC[38;2;R;G;Bm   (foreground)
                ESC[48;2;R;G;Bm   (background)
  ```
- 缓存：首次解码后写到 `~/.chovy/cache/companion/<gif-hash>/<frame>.ansi`，
  二次启动直接读缓存（启动 < 200ms 目标）。
- 原色：渲染器只做透明像素合成与等比缩放，不做主题调色、滤镜、色相旋转；低色终端只能做最近色降级，不能把 GIF 改成主题色。
- 尺寸：主屏默认 20 列，窄屏 14-16 列，欢迎页最大 20 列；超过 24 列必须是显式用户设置，超过 28 列拒绝（防止吉祥物抢走输入区）。

### 状态机

5 个吉祥物文件 = 5 种 chovy-code 内部状态：

| 状态 | GIF 文件 | 触发条件 |
|---|---|---|
| `idle` | `gif/2026-06-12_012827.GIF` | REPL 待输入 |
| `work` | `gif/2026-06-12_012830.GIF` | runAgent 进行中（busy=true） |
| `think` | `gif/2026-06-12_012832.GIF` | 有 thinking token 流但未触发工具 |
| `done` | `gif/2026-06-12_012835.GIF` | runAgent 成功收尾 5s 内 |
| `error` | `gif/2026-06-12_234328.GIF` | 工具 / provider 错误 |

### 与 cc-haha 必须避免的 6 处差异（差异化清单）

1. **不抄 SpeechBubble 的 ╲╲ 锯齿尾巴**——chovy-code 用「**·    ·    ·**」三点延伸，更克制。
2. **不抄"稀有度"概念**（`RARITY_COLORS`）——chovy-code 的吉祥物只有"皮肤"概念（5 个 GIF + 用户自定义），不分 common/rare。
3. **不复制 IDLE_SEQUENCE 数组**——cc-haha 用 `[0,0,0,0,1,0,0,0,-1,0,0,2,0,0,0]`；
   chovy-code 让 GIF **自带帧序列与 delay**，不再做 idle 序列叠加。
4. **不抄"footerSelection === 'companion'"全局聚焦标记**——chovy-code 用 step-57 的 5-way 焦点环，吉祥物焦点叫 `"companion"`，但**不进入** AppState 全局，仅在 repl 局部 useState。
5. **不抄"feature('BUDDY')"开关**——chovy-code 用 `CHOVY_NO_COMPANION=1` env 兜底（AGENTS.md §22/§23 同模式）。
6. **不抄大尺寸装饰位**——chovy-code 的 GIF 是辅助反馈，默认小尺寸，永远不能挤压 MessageList / InputBox。

---

## 2. 创新 #2：Ctrl+P 命令面板（PALETTE-CN）

### 设计

mimo-code 的 dialog-settings 是 **Electron React 模态**；chovy-code 必须做成**纯 Ink overlay**，
但视觉风格对齐图 4 那种「**搜索 + 推荐 + 分类 + 高亮**」结构。

布局（详见 `step-41`）：

```
╔═════════════════════════════════════════════════════════════════╗
║  命令                                                           ║
║                                                                 ║
║  > [搜]索...                                                    ║
║                                                                 ║
║  推荐                                                           ║
║    切换会话                                          ctrl+x l   ║
║    切换模型                                          ctrl+x m   ║
║                                                                 ║
║  会话                                                           ║
║    打开编辑器                                        ctrl+x e   ║
║  ▶ 切换会话                                          ctrl+x l   ║   ← 高亮（紫色背景）
║    工作流                                                       ║
║    新建会话                                          ctrl+x n   ║
║  ↑↓ 选择 · Enter 执行 · Esc 关闭                       32 项   ║
╚═════════════════════════════════════════════════════════════════╝
```

### 中文模糊搜索

mimo / cc-haha 的命令面板都按 ASCII 单词搜，对中文不友好。chovy-code 内置 **trigram + 拼音首字母** 双匹配：

- 输入「sm」→ 命中「**S**witch **M**odel」/「**切**换**模**型」（拼音首字母）。
- 输入「切换」→ 命中所有含「切换」子串的项（trigram）。
- 不内置完整 jieba（太重）；用一份 ~2KB 的高频字 → 拼音首字母 lookup 表 `i18n/pinyin-initials.ts`。

### 命令注册三层

```ts
// palette/registry.ts
export interface PaletteCommand {
  id: string;                 // "session.switch"
  label: () => string;        // i18n: t('palette.session.switch')
  category: "session"|"model"|"provider"|"settings"|"prompt"|"message"|"goal"|"memory"|"skills"|"companion"|"diagnostics"|"tools";
  hotkey?: string;            // keybinding id；显示文本从 keybindings 单源取
  slash?: { name: string; aliases?: string[]; argsHint?: string };
  suggested?: boolean | ((ctx: ReplCtx) => boolean);
  hidden?: boolean | ((ctx: ReplCtx) => boolean);
  enabled?: (ctx: ReplCtx) => boolean;
  direct?: boolean;           // true 直接执行，false 预填 /cmd
  run(ctx: ReplCtx): Promise<void> | void;
}
```

命令覆盖面必须明显多于 step-30：Phase L smoke 要达到 `commandEquivalents >= 72`，覆盖 session/model/provider/settings/theme/language/buddy/goal/memory/skills/diagnostics/message/input 等类别。
其中 `/` 命令与 Ctrl+P 命令共享 registry；`/help` 只展示 registry，不维护第二份列表。Skills、plugins、workflows、MCP 命令通过 `cli/commandSources.ts` 进入 command store，`palette/` 不直接 import 后端模块。

### 与 mimo 差异化 3 处

1. **不复制 mimo 的橙色高亮**——chovy-code 用主题 `primary`（紫）做选中主色，`accent`（蓝）只作辅助焦点。
2. **不抄 mimo "esc" 在标题右上的位置**——chovy-code 的 esc 提示放在底部 hotkeyBar，与既有 SwarmPanel 一致。
3. **MRU 推荐**：chovy-code 自己加 ——「最近 30 天用过的命令」按使用次数 + 衰减排序，存
   `~/.chovy/cache/palette-mru.json`。mimo 的「推荐」是写死的列表。

---

## 3. 创新 #3：紫蓝主题 + 持久化（THEME-VB）

### 设计

默认主题 `ChovyDefault`：

```ts
{
  name: "ChovyDefault",
  primary:   "#7C3AED",   // violet-600（主边框 / 选中 / 标题）
  accent:    "#3B82F6",   // blue-500（辅助焦点 / 次级 action）
  bg:        "default",   // 跟随终端
  fg:        "#E5E7EB",   // 浅灰
  muted:     "#6B7280",   // 灰
  success:   "#10B981",
  warning:   "#F59E0B",
  error:     "#EF4444",
  borderStyle: "round",
}
```

附 4 个内置备选：

- `ChovyLight`（浅色，吉祥物适配）
- `ChovyHighContrast`（无障碍）
- `ChovySolarized`（暖色）
- `ChovyMonochrome`（单色，不挂主题色，给 SSH/低能力终端）

### 自定义

`config.json` 增加：

```json
{
  "theme": {
    "name": "ChovyDefault",
    "custom": {
      "primary": "#A855F7",
      "accent": "#38BDF8"
    }
  }
}
```

`custom` 字段会**深合并**到 `name` 解析出的内置主题上，缺什么字段用内置默认值兜底。
主题只控制 UI token，不控制 GIF 原图颜色。

### Ink 颜色映射

Ink 不直接支持自定义 hex，必须把 `theme.primary` 映射到 Ink color name。chovy-code 内置一个 16 色 palette mapper：
找最近的 ANSI 16 色名（`magenta`/`cyan`/...）作为 fallback，**真彩色终端**走 `<Text color="#7C3AED">`（Ink 5+ 支持）。

### 与 cc-haha 差异

cc-haha 的 `theme.ts` 是个 enum-like 结构，没暴露给用户；chovy-code 主题是**第一公民**，
有完整的 `/theme list|set|create` 命令 + Settings 界面分类，且默认值是「紫蓝」而非黑红。

---

## 4. 创新 #4：中文优先 i18n（I18N-CN）

### 设计

`Locale = "zh" | "en"`，`LocalePreference = Locale | "auto"`，**新安装默认中文**。
运行时对外暴露 `getLocalePreference()` 与 `getLocale()`：前者是用户选择，后者是 effective locale。`zh-CN` / `en-US` 只是兼容 alias，保存时归一化成 `zh` / `en`。

本阶段完整采用 MiMo TUI 的语言结构：`LOCALES` / `INTL` / `LABEL_KEY` / `normalizeLocale()`、英文 base fallback、loader/cache、flatten nested dict、`{{ param }}` 模板、UiI18nBridge。chovy 只内置中英两套字典，不引入在线翻译或 i18next。

### i18n 范围（重要 · 不变量）

**命令名按 cc-haha 风格保持英文**——只翻译 UI 标签 / 提示 / 描述。具体边界：

| 类别 | 是否走 i18n | 示例 |
|---|---|---|
| Slash 命令名 | ❌ **保持英文**（不翻译） | `/help` `/goal` `/buddy pet` `/theme set` `/lang en` `/clear` `/quit` `/checkpoint now` |
| CLI 子命令 | ❌ **保持英文** | `chovy chat` `chovy goal` `chovy mem search` `chovy config --non-interactive` |
| Keybinding ID | ❌ **保持英文** | `palette.open` `settings.open` `i18n.toggle` `buddy.pet` |
| Provider / Model 名 | ❌ **保持英文** | `openai/gpt-4o` `anthropic/claude-sonnet-4` `kimi/k2` |
| 主题名 | ❌ **保持英文** | `ChovyDefault` `ChovyLight` `ChovyHighContrast` |
| Telemetry 事件 type | ❌ **保持英文** | `tui.theme.change` `tui.locale.change` |
| Field ID | ❌ **保持英文** | `theme.name` `provider.apiKey` `i18n.locale` |
| **UI 标签 / 标题 / 段落** | ✅ **走 i18n** | "命令" "设置" "服务商" "上手提示" |
| **UI 提示 / placeholder** | ✅ **走 i18n** | "搜索…" "再次按 Ctrl+C 退出" |
| **错误 / toast 文本** | ✅ **走 i18n** | "刚刚出错了，要不要看看？" |
| **Slash / 命令的 *描述*** | ✅ **走 i18n** | "/help — 显示帮助" 中"显示帮助"走 i18n |

字典结构示例（注意 key 是 ID，value 是要显示给用户看的文本）：

```ts
// i18n/locales/zh.ts
export const zh = {
  "palette.title": "命令",                       // UI 面板标题 → 翻译
  "palette.search.placeholder": "搜索",          // placeholder → 翻译
  "palette.section.recommend": "推荐",           // 分组标题 → 翻译
  "settings.title": "设置",
  "settings.category.general": "常规",
  "settings.category.provider": "服务商",
  "settings.category.model": "模型",
  "settings.category.theme": "主题",
  "settings.category.language": "语言",
  "settings.category.keybind": "键位",
  "settings.category.advanced": "高级",
  "welcome.greet": "欢迎回来！",
  "companion.bubble.work": "我在干活！",         // 吉祥物气泡 → 翻译
  "header.mode.default": "default 模式",          // 注意：保留英文 mode 名 + 中文 "模式"
  "header.cost": "花费 {{ cost }}",              // 数字货币标签 → 翻译
  "slash.help.desc": "显示帮助",                 // /help 的描述（命令名 /help 不译）
  "slash.goal.desc": "进入长程任务循环",
  "slash.buddy.desc": "与吉祥物互动",
  "slash.theme.desc": "切换主题",
  "slash.lang.desc": "切换语言",
  // ...
};
```

> 渲染时：palette / help overlay 显示「`/help` — 显示帮助」——左半英文命令名是字面量、右半 `t("slash.help.desc")` 走字典。
> 这样中文用户看得懂作用、命令本身仍是 cc-haha 兼容的英文打字。

### 切换路径

- `/lang zh` / `/lang en` / `/lang auto` slash 命令（命令名英文，参数枚举也英文）；
- `Ctrl+L` 全局快捷键；
- Settings → Language（标题"语言"中文，但选项 value 仍是 `zh` / `en` / `auto` 英文 ID，显示 label 走 `labelLocale()`）；
- 启动时 `process.env.LANG` / `process.env.LC_ALL` 探测兜底（一次性，不实时跟随）。

### 与 mimo 差异

- 不抄 mimo 的 i18next 框架（重）——chovy-code 自实现轻量 `t()` + `resolveTemplate()`：dictionary lookup + `{{ param }}` 占位符替换 + missing-key fallback。
- 借鉴并采用 mimo 的 `preference/effective/label/base/cache/loader/bridge` 结构，但只内置 zh / en 两套字典；多语言扩展只能追加 locale union 与字典文件。
- 不内置 RTL（阿语 / 希伯来语），明确写在 KNOWN-LIMITATIONS。
- **新加 key 必须同时加 zh + en**——CI smoke 校验 key 集合相等，缺一即 fail（step-32 要点）。
- **命令名 / ID 永远不进字典**：CI smoke 同时校验字典 value 不含 `/help` `/goal` 等 slash 字面量（防止误把命令翻译进字典 → 双源漂移）。

---

## 5. 创新 #5：流畅度三件套（SMOOTH-3）

### 设计

把"流畅"拆成 3 个具体不变量，让后续步骤可量化：

#### 5.1 输入零延迟

InputBox v2（step-53）所有按键反馈 **同帧**渲染（≤ 16ms）；不在 keypress handler 里跑同步 fs read /
i18n lookup（提前缓存）；命令面板搜索 debounce 80ms（输入完再搜，不每键搜）。

#### 5.2 状态过渡有动画但不卡

micro-animations（step-56）只用 setInterval 切帧，不引入动画库；
spinner 100ms / 帧；fade-in 6 帧 × 50ms；slide-up 5 帧 × 32ms；用户可一键关闭（`config.tui.animations: false`）。

#### 5.3 一致的焦点反馈

step-57 全局焦点环：

```
input → palette → settings → swarm → goal → companion → input
```

任一可见面板加入环；不可见自动跳过。**焦点元素必须有 1 像素以上的视觉区分**（边框色变 accent / 反相 / 加 ▎前缀），
键盘提示行常驻（"Tab 切换 / Esc 退出"）。

### 与 cc-haha / mimo 差异

cc-haha 的 fullscreen 模式用 `<FullscreenLayout>` 整屏切换（很重）；
chovy-code 不做 fullscreen，所有面板都 inline overlay 叠加在 REPL 内，节省 SSH / 远程终端的滚动条破坏。

---

## 6. 与 cc-haha 相似但不抄袭的界面边界

用户体验目标是“cc-haha 级别的丰富度与操作性”，不是视觉或代码克隆。允许相似的是产品结构，禁止相同的是实现细节、命名、素材与视觉符号。

| 可以对齐 | chovy 采用方式 | 禁止照搬 |
|---|---|---|
| 高密度命令入口 | Ctrl+P / `/` / HelpOverlay 同源，命令分组覆盖 session/model/config/skills/diagnostics | 复制 cc-haha command module 代码或命令内部实现 |
| 快捷键可发现 | footer hotkey bar、右对齐 hotkey 列、Settings Keybindings 页 | 复制 cc-haha 帮助页布局、文字和边框 |
| 诊断入口丰富 | `/status` `/doctor` `/review` `/security-review` 等进入 diagnostics group | 复制 cc-haha 的私有/internal-only 命令与 ant-only 入口 |
| 技能生态 | bundled/project/user/只读外部 skills 统一进 CSG registry | 把 cc-haha bundled skill 文件直接搬过来，或丢掉 CSG 图 |
| 吉祥物陪伴感 | 小尺寸原色 GIF + chovy speech bubble + `/buddy` alias | sprite 数组、rarity、hatch/release、IDLE_SEQUENCE |
| 面板操作模式 | overlay、搜索、分组、MRU、source label、disabled reason | fullscreen takeover、同样的高亮色、相同的标题/esc 位置 |

验收时看“用户能做的事”是否对齐 cc-haha：能快速找命令、改设置、切模型、查状态、用 skills、诊断问题；不是看截图是否相似。

---

## 7. 红线（绝对避免抄袭的 8 处）

> PR 评审时这 8 条会被显式 grep。命中即拒绝合并。

| # | 必须避免 | 来源 | chovy-code 替代 |
|---|---|---|---|
| 1 | `RARITY_COLORS` 命名 | cc-haha buddy/types | 不分稀有度 |
| 2 | `IDLE_SEQUENCE = [0,0,0,0,1,0,0,0,-1,...]` | cc-haha CompanionSprite | GIF 自带 frame delay |
| 3 | `feature('BUDDY')` Bun bundle 特性 | cc-haha | `CHOVY_NO_COMPANION=1` env |
| 4 | mimo 命令面板的橙色 `#FF7A00` 高亮 | mimo dialog-settings | `theme.primary`（默认紫）+ `theme.accent`（默认蓝） |
| 5 | mimo 的 `i18next` 依赖 | mimo language context | 自实现轻量 `t()` / loader / cache |
| 6 | cc-haha `<FullscreenLayout>` 整屏切换 | cc-haha fullscreen.ts | inline overlay |
| 7 | cc-haha "buddy" 与 "companion" 双命名 | cc-haha buddy/companion | chovy-code 统一叫 `companion`，slash 命令叫 `/buddy` 仅作 alias |
| 8 | 对 GIF 做主题调色 / 放大成主视觉 | 通用 TUI 装饰做法 | 保持 GIF 原色，小尺寸辅助反馈 |

---

## 8. 创新与既有 5 项创新（ATP/SwarmR/TMT/SCW/CSG）的关系

本 TUI 阶段的 5 项 TUI 创新（BUDDY-GIF / PALETTE-CN / THEME-VB / I18N-CN / SMOOTH-3）**与既有 5 项后端创新平行**：

- 既有 5 项是 **agent 内核能力**（在 `engine/` `tools/` `swarm/` `memory/` `context/` `skills/`）；
- 本阶段 5 项是 **UI 层产品形态**（在 `cli/` `theme/` `i18n/` `keybindings/` `companion/` `palette/` `screens/`）。

**不重叠 / 不依赖**：BUDDY-GIF 不调用 SwarmR；PALETTE-CN 不感知 SCW；TMT 不被 i18n 打扰。
TUI 是消费者，agent 内核是生产者。
