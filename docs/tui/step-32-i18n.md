# Step 32 — i18n 中英双语（dictionary + Provider + /lang）

**Phase**: J | **依赖**: step-02 (config) | **可并行**: 31, 33 | **估时**: 4h | **创新**: I18N-CN

## 目标

让 chovy-code TUI **默认中文（zh-CN）**，可在运行时切到英文（en-US）。所有 **UI 文本** 走 `t(key, params?)`，
key 缺失时打印 `[missing: key]` 并 telemetry warn 一次（同 key 一次会话内只 warn 一次）。

**关键边界（与 cc-haha 对齐）**：**命令名 / 标识符保持英文，只翻译 UI 标签 / 提示 / 描述**。
详细范围见 `innovations.md §4 i18n 范围` 表格——本步实现严格遵守该表。

简述：

| 不翻译（永远英文） | 翻译（走 i18n） |
|---|---|
| Slash 命令名（`/help` `/goal` `/buddy pet` `/theme set` `/lang en`） | UI 面板标题（"命令" "设置" "上手提示"） |
| CLI 子命令（`chovy chat` `chovy mem search`） | 提示 / placeholder（"搜索…" "再次按 Ctrl+C 退出"） |
| Keybinding ID（`palette.open` `i18n.toggle`） | 错误 / toast / bubble 文本（"刚刚出错了…"） |
| 主题 / Provider / Model / Field ID | **slash 命令的 *描述*** （`/help` 后面那段"显示帮助"走 i18n） |
| Telemetry event type | **设置项 label**（"主题" "服务商"——但 field id 仍英文） |

## 产物

```
src/i18n/
├── index.ts                  # t() / getLocale / setLocale / onLocaleChange
├── locales/
│   ├── zh-CN.ts              # 默认字典（≥ 200 key）
│   └── en-US.ts              # 英文镜像
├── format.ts                 # 数字/日期/百分比 locale-aware 格式
├── detect.ts                 # env LANG / config.locale 启动时探测
└── pinyin-initials.ts        # ~2KB 中文 → 拼音首字母 lookup（step-42 共用）

src/cli/slashCommands/lang.ts  # /lang zh|en
```

## 实现要点

### 1. dictionary 结构

注意：**key 是英文 ID**（永远不变），**value 才是翻译文本**。命令名 `/help` `/goal` 等**绝不**作为 key 也**绝不**作为 value 字面量出现。

```ts
// src/i18n/locales/zh-CN.ts
export const zhCN: Record<string, string> = {
  // ── UI 面板标题 ──
  "palette.title": "命令",
  "palette.search.placeholder": "搜索",
  "palette.section.recommend": "推荐",
  "palette.section.session": "会话",
  "settings.title": "设置",
  "settings.category.general": "常规",
  "settings.category.provider": "服务商",
  "settings.category.theme": "主题",
  "settings.category.language": "语言",
  "settings.category.keybind": "键位",

  // ── 启动屏 ──
  "welcome.greet": "欢迎回来！",
  "welcome.tips.title": "上手提示",
  "welcome.tips.palette": "按 Ctrl+P 打开命令面板",      // 注意保留 "Ctrl+P" 字面量
  "welcome.tips.settings": "按 Ctrl+, 进入设置",
  "welcome.tips.lang": "按 Ctrl+L 中英切换",

  // ── HeaderBar ──
  "header.cost": "花费 {cost}",                          // {cost} 占位符由 formatCost 填
  "header.ctx": "上下文 {pct}%",
  "header.mode.default": "default 模式",                 // 保留英文 mode 名 + 中文 "模式"
  "header.mode.plan": "plan 模式",
  "header.mode.acceptEdits": "accept-edits 模式",
  "header.mode.auto": "auto 模式",
  "header.mode.bypass": "bypass 模式",

  // ── 吉祥物气泡 ──
  "companion.bubble.idle": "在等你的指令哦",
  "companion.bubble.work": "我在干活！",
  "companion.bubble.error": "刚刚出错了，要不要看看？",
  "companion.bubble.done.success1": "搞定啦！",

  // ── InputBox / 系统消息 ──
  "input.placeholder": "输入消息或 / 开头的命令…",
  "msg.cancelled": "已取消",
  "msg.busy": "运行中",

  // ── Slash 命令的 *描述*（命令名本身保留英文，不进字典）──
  "slash.help.desc":       "显示帮助",
  "slash.goal.desc":       "进入长程任务循环",
  "slash.buddy.desc":      "与吉祥物互动",
  "slash.theme.desc":      "切换主题",
  "slash.lang.desc":       "切换中英语言",
  "slash.checkpoint.desc": "立即生成 / 列出快照",
  "slash.config.desc":     "配置 provider / model / API key",
  "slash.mem.desc":        "查询记忆",
  "slash.skill.desc":      "查看 / 激活技能",
  "slash.clear.desc":      "清空消息",
  "slash.quit.desc":       "退出",

  // ── 设置 field label（field id 仍英文如 "theme.name"，label 走 i18n）──
  "settings.field.theme":          "主题",
  "settings.field.theme.primary":  "主色（primary）",   // 注意保留英文 token 名
  "settings.field.theme.accent":   "强调色（accent）",
  "settings.field.theme.border":   "边框样式",
  "settings.field.provider":       "服务商",
  "settings.field.model":          "模型",
  "settings.field.apiKey":         "API 密钥",
  "settings.field.locale":         "界面语言",
  "settings.field.companionMuted": "静音吉祥物",
  "settings.field.animations":     "启用动画",
  "settings.field.costInCNY":      "费用以人民币显示（汇率折算）",

  // ── 校验提示 ──
  "settings.validate.hex":         "请输入 #RRGGBB 形式的十六进制颜色",
  "settings.validate.empty":       "不能为空",
  "settings.validate.secretEmpty": "API 密钥不能为空",

  // ── 快捷键提示 ──
  "focus.hint":          "当前焦点：{target} · Tab 切换 · Esc 回到输入",
  "focus.target.swarm":  "Swarm 面板",
  "focus.target.goal":   "Goal 面板",
  "focus.target.companion": "吉祥物",

  // ── Toast ──
  "toast.cleared":          "已清屏",
  "toast.cmdFailed":        "命令 {name} 执行失败：{msg}",     // {name} 不译，是命令字面量
  "toast.swarm.done":       "Swarm 完成 {ok}/{total}",         // "Swarm" 保留英文
  "toast.checkpoint.written": "已写入快照 {path}",

  // ≥ 200 key 详见实施
};
```

英文镜像示例（key 完全相同）：

```ts
// src/i18n/locales/en-US.ts
export const enUS: Record<string, string> = {
  "palette.title": "Commands",
  "palette.search.placeholder": "Search",
  "palette.section.recommend": "Recommended",
  "settings.title": "Settings",
  "settings.category.general": "General",
  "settings.category.provider": "Providers",
  "settings.category.theme": "Theme",
  "settings.category.language": "Language",
  "settings.category.keybind": "Keybindings",
  "welcome.greet": "Welcome back!",
  "welcome.tips.palette": "Press Ctrl+P to open command palette",
  "header.mode.default": "default mode",
  "companion.bubble.work": "Working hard!",
  "input.placeholder": "Type a message or / for commands…",
  "slash.help.desc":       "Show help",
  "slash.goal.desc":       "Start a long-horizon goal loop",
  "slash.buddy.desc":      "Interact with companion",
  "slash.theme.desc":      "Switch theme",
  "slash.lang.desc":       "Switch language",
  "settings.field.theme":          "Theme",
  "settings.field.theme.primary":  "Primary color",
  "settings.field.apiKey":         "API key",
  "focus.hint": "Focused: {target} · Tab to cycle · Esc to return",
  // ...
};
```

`en-US.ts` **必须**包含同样的 key 集合（CI smoke 校验）。

### 2. `t()` 极简实现（≤ 80 行）

```ts
// src/i18n/index.ts
let _locale: Locale = "zh-CN";
let _dict: Record<string, string> = zhCN;
const _missingWarned = new Set<string>();
const _listeners = new Set<(l: Locale) => void>();

export function t(key: string, params?: Record<string, string|number>): string {
  let s = _dict[key];
  if (s === undefined) {
    if (!_missingWarned.has(key)) {
      _missingWarned.add(key);
      logger.warn(`[i18n] missing key: ${key} (locale=${_locale})`);
    }
    return `[missing: ${key}]`;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export function setLocale(loc: Locale): void {
  _locale = loc;
  _dict = loc === "zh-CN" ? zhCN : enUS;
  persistLocale(loc);
  emit({ type: "tui.locale.change", locale: loc });
  for (const l of _listeners) try { l(loc); } catch {}
}
```

### 3. detect.ts（启动一次）

```ts
export function detectInitialLocale(cfgLocale?: string, envLang?: string): Locale {
  if (cfgLocale === "zh-CN" || cfgLocale === "en-US") return cfgLocale;
  if (envLang && /^en/i.test(envLang)) return "en-US";
  return "zh-CN";  // 默认中文（与 §1 不变量一致）
}
```

CLI 入口 `src/cli/index.tsx` 在 `resolveCtx()` 之后立即调一次 `setLocale(detectInitialLocale(...))`。

### 4. /lang slash 命令 + Ctrl+L 快捷键

命令名 `/lang` 与参数枚举 `zh` / `en` **保留英文**——这是 ID，不走翻译；只有 toast 反馈用 i18n。

```
/lang zh    → setLocale("zh-CN") + toast: t("toast.lang.changed")
/lang en    → setLocale("en-US")
/lang       → toast: 显示当前 locale + 用法（"/lang zh|en"）
```

`Ctrl+L` 在 step-34 keybinding 注册为 ID `i18n.toggle`（**英文 ID**），按下时 toggle zh ↔ en。

### 5. format.ts

```ts
export function formatCost(usd: number): string {
  return getLocale() === "zh-CN" ? `￥${(usd * 7.2).toFixed(4)}` : `$${usd.toFixed(4)}`;
  // 默认人民币显示折算（汇率 7.2 写死，KNOWN-LIMITATIONS 注明不实时）
}
export function formatPct(used: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((used / total) * 100)}%`;
}
```

> 折算汇率写死是有意的：「实时汇率」会引入网络副作用，违反 §9 红线。用户嫌不准可关闭折算（`config.i18n.costInCNY: false`）。

## 接口冻结 / 不变量

- `Locale` 联合扩展只**追加**成员（`"zh-CN"|"en-US"|"ja-JP"|...`），不替换。
- `t()` 签名冻结（B8）：返回值永远是 `string`，**不**抛；missing-key 走 warn + sentinel。
- key 命名约定：`<domain>.<sub>.<concrete>`（**英文小写、点分**），不超 5 段，不夹空格。
- zh/en 字典 key 集合**必须严格相等**：`scripts/smoke-step32.ts` 跑 `Object.keys` 差集断言空。
- **i18n 范围红线（与 cc-haha 命名兼容）**：以下**永远不进字典**——
  - Slash 命令名：`/help` `/goal` `/buddy pet` `/theme set` `/lang en` `/clear` `/quit` 等；
  - CLI 子命令：`chovy chat` `chovy goal` `chovy mem` `chovy config` 等；
  - Keybinding ID：`palette.open` `settings.open` `i18n.toggle` `buddy.pet` 等；
  - Provider / Model / Theme / Field ID：`openai` `gpt-4o` `ChovyDefault` `theme.name` 等；
  - Telemetry event type：`tui.theme.change` `tui.locale.change` 等。
  smoke 用 grep 校验字典 value 中**不包含** `^/[a-z]+` 形式的 slash 字面量（白名单：`{cost}` 等占位符）。
- **slash 命令的描述**走 i18n，key 形如 `slash.<name>.desc`（如 `slash.goal.desc`）；
  渲染时拼成「`/goal` — 进入长程任务循环」（左侧字面量 + 右侧 t() 文本）。

## 验收标准

- `bun run typecheck` 通过；
- `bun -e "import('./src/i18n/index.js').then(m=>{m.setLocale('en-US');console.log(m.t('welcome.greet'))})"` 输出 `Welcome back!`；
- `chovy chat` 启动 → HeaderBar 文字中文（如 "default 模式"，注意 `default` 仍是英文 token）；`/lang en` → 立即变英文；重启仍是 en；
- smoke：临时 home → 无 `LANG` env → 默认 zh-CN；`LANG=en_US.UTF-8` → 默认 en-US；
- key 集合等价检查通过；missing-key warn 单 key 单次；
- **i18n 范围 smoke**：`Object.values(zhCN)` 与 `Object.values(enUS)` 中**不**含正则 `^/[a-z][a-z-]+$` 的子串（即没有把 `/help` 等命令名翻译进字典）；
- 命令面板 / help overlay 渲染：英文命令名 + 中文描述并列（如「`/goal` — 进入长程任务循环」）。

## 风险

- **新加 key 漏 en**：CI 守门防回退；本地开发用 `bun run scripts/i18n-check.ts` 自检。
- **拼音首字母覆盖率**：`pinyin-initials.ts` 仅覆盖 GB2312 一级 + 二级常用字（≈ 6700 字），冷僻字 fallback 到原字符匹配。step-42 复用此表。
- **i18n 与主题无关**：locale 切换不应触发 theme 重算；两条事件流独立。
