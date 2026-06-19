# Step 32 — MiMo 式 i18n 中英双语内核（dictionary + Provider + /lang）

**Phase**: J | **依赖**: step-02 (config) | **可并行**: 31, 33 | **估时**: 4h | **创新**: I18N-CN

## 目标

让 chovy-code TUI **新安装默认中文**，可在运行时切到英文或设为 auto。语言架构按 MiMo TUI 的设计完整复刻其分层思路（不复制 Solid/OpenTUI 代码）：

- `LocalePreference = Locale | "auto"`：用户保存的是 preference；
- `effective Locale`：UI 渲染使用系统探测后的有效语言；
- `LOCALES` / `INTL` / `LABEL_KEY`：语言枚举、Intl code、语言名 label 分离；
- `base` fallback：英文 base 字典永远可用，中文覆盖英文；
- `loaders + cache`：字典加载与缓存分离，未来追加 locale 不改 `t()`；
- `flatten()`：允许源字典嵌套，运行时使用点分 key；
- `resolveTemplate()`：模板使用 MiMo 风格 `{{ param }}`。

chovy 第一阶段只内置 `zh` 与 `en` 两套字典，但兼容用户输入和旧配置里的 `zh-CN` / `en-US`。所有 **UI 文本** 走 `t(key, params?)`；命令名 / provider / model / keybinding ID 永远英文。

### MiMo 对齐合同

已核对 MiMo `packages/opencode/src/cli/cmd/tui/context/language.tsx` 与 `i18n/locales.ts`。step-32 不允许把该设计缩水成简单 `if (lang === "zh")`：

| MiMo 结构 | chovy 必须采用的设计 | 不允许的缩水实现 |
|---|---|---|
| `base = flatten(en)` | 英文 `en` 是 base dictionary，任何 locale 都先继承 base | zh/en 两份散落对象分别查找 |
| `loaders` + `cache` | 非 base locale 通过 loader 合并 `{ ...base, ...flatten(locale) }`，并按 locale 缓存 | 每次 `t()` 都重新读配置或重新 flatten |
| `preference` / `effective` | 用户保存 `LocalePreference`，渲染使用 `effective Locale` | 把 `"auto"` 直接当成可渲染 locale |
| `LOCALES` / `INTL` / `LABEL_KEY` | 语言 ID、Intl code、语言名称 i18n key 分离 | 在 UI 内硬编码 `"简体中文"` / `"English"` |
| `normalizeLocale()` | 兼容 alias，但持久化只写 `zh` / `en` / `auto` | 把 `zh-CN` / `en-US` 写回配置 |
| `translator(..., resolveTemplate)` | 模板统一使用 `{{ param }}`，缺参为空字符串 | 混用 `{param}`、`${param}` 或直接字符串拼接 |
| `UiI18nBridge` | `tui/kit`、`palette`、`screens` 通过 bridge 拿 `{ locale, t }` | 组件直接 import config 或直接读取 env |

验收时要检查这些结构名和行为是否存在；仅能显示中英文但没有上述分层，不算 step-32 完成。

## 产物

```
src/i18n/
├── index.ts                  # t() / setLocale / getLocale / getLocalePreference / labelLocale
├── locales.ts                # Locale / LOCALES / INTL / LABEL_KEY / normalizeLocale
├── flatten.ts                # flatten nested dict + resolveTemplate
├── locales/
│   ├── en.ts                 # base dictionary（英文）
│   └── zh.ts                 # 默认中文覆盖
├── format.ts                 # 数字/日期/百分比 locale-aware 格式
├── detect.ts                 # LANG / LC_ALL / config.i18n.locale 探测
├── bridge.ts                 # UiI18nBridge：给 tui/kit / palette / screens 注入 t()
└── pinyin-initials.ts        # ~2KB 中文 → 拼音首字母 lookup（step-42 共用）

src/cli/slashCommands/lang.ts  # /lang zh|en|auto
```

## 实现要点

### 1. Locale 基础结构

```ts
// src/i18n/locales.ts
export type Locale = "zh" | "en";
export type LocaleAlias = "zh-CN" | "en-US";
export type LocalePreference = Locale | "auto";

export const LOCALES = ["zh", "en"] as const;
export const INTL: Record<Locale, string> = {
  zh: "zh-Hans",
  en: "en",
};
export const LABEL_KEY: Record<Locale, string> = {
  zh: "language.zh",
  en: "language.en",
};

export function normalizeLocale(value: string | undefined): Locale {
  const raw = (value ?? "").toLowerCase();
  if (raw === "zh" || raw === "zh-cn" || raw.startsWith("zh_hans") || raw.startsWith("zh-cn")) return "zh";
  if (raw === "en" || raw === "en-us" || raw.startsWith("en_") || raw.startsWith("en-")) return "en";
  return "zh";
}
```

注意：`Locale` 内部 ID 使用 MiMo 式短 ID；用户可继续输入 `/lang zh`、`/lang en`、`/lang auto`，配置迁移兼容 `zh-CN` / `en-US`。

### 2. 字典结构与 flatten

源字典可以嵌套，运行时 flatten 为点分 key。英文是 base，中文只需要覆盖显示文本，但 smoke 会要求 zh/en key 集合最终等价。

```ts
// src/i18n/locales/en.ts
export const en = {
  language: {
    zh: "Chinese (Simplified)",
    en: "English",
    auto: "Auto",
    current: "Current",
  },
  palette: {
    title: "Commands",
    search: { placeholder: "Search" },
    section: { recommend: "Recommended", session: "Session" },
  },
  slash: {
    help: { desc: "Show help" },
    goal: { desc: "Start a long-horizon goal loop" },
    buddy: { desc: "Interact with companion" },
    theme: { desc: "Switch theme" },
    lang: { desc: "Switch language" },
  },
  header: {
    cost: "Cost {{ cost }}",
    ctx: "Context {{ pct }}%",
    mode: { default: "default mode", plan: "plan mode" },
  },
} as const;
```

```ts
// src/i18n/locales/zh.ts
export const zh = {
  language: {
    zh: "中文（简体）",
    en: "English",
    auto: "自动",
    current: "当前",
  },
  palette: {
    title: "命令",
    search: { placeholder: "搜索" },
    section: { recommend: "推荐", session: "会话" },
  },
  slash: {
    help: { desc: "显示帮助" },
    goal: { desc: "进入长程任务循环" },
    buddy: { desc: "与吉祥物互动" },
    theme: { desc: "切换主题" },
    lang: { desc: "切换界面语言" },
  },
  header: {
    cost: "花费 {{ cost }}",
    ctx: "上下文 {{ pct }}%",
    mode: { default: "default 模式", plan: "plan 模式" },
  },
} as const;
```

命令名 `/help`、`/goal` 不进入字典 value；help overlay 渲染时拼成「`/goal` — `t("slash.goal.desc")`」。

### 3. `t()` 与 loader/cache

```ts
// src/i18n/index.ts
type Params = Record<string, string | number | boolean>;
type Dictionary = Record<string, string>;

const base = flatten(en);
const cache = new Map<Locale, Dictionary>([["en", base]]);
const loaders: Record<Locale, () => Promise<Dictionary>> = {
  en: async () => base,
  zh: async () => ({ ...base, ...flatten(zh) }),
};

let preference: LocalePreference = "zh";
let effective: Locale = "zh";
let dict: Dictionary = { ...base, ...flatten(zh) };
const missingWarned = new Set<string>();

export function t(key: string, params?: Params): string {
  const template = dict[key] ?? base[key];
  if (template === undefined) {
    if (!missingWarned.has(key)) {
      missingWarned.add(key);
      logger.warn(`[i18n] missing key: ${key} (locale=${effective})`);
    }
    return `[missing: ${key}]`;
  }
  return resolveTemplate(template, params);
}

export async function setLocale(next: LocalePreference | LocaleAlias): Promise<void> {
  preference = next === "auto" ? "auto" : normalizeLocale(next);
  effective = preference === "auto" ? detectSystemLocale() : preference;
  dict = cache.get(effective) ?? await loaders[effective]();
  cache.set(effective, dict);
  persistLocalePreference(preference);
  emit({ type: "tui.locale.change", locale: effective, preference });
}
```

`resolveTemplate("Cost {{ cost }}", { cost: "$0.12" })` 缺参数时替换为空字符串，行为与 MiMo UI context 一致。

### 4. detect.ts

```ts
export function detectInitialPreference(cfgLocale?: string): LocalePreference {
  if (cfgLocale === "auto") return "auto";
  if (cfgLocale === "zh" || cfgLocale === "en" || cfgLocale === "zh-CN" || cfgLocale === "en-US") {
    return normalizeLocale(cfgLocale);
  }
  return "zh"; // 新安装默认中文
}

export function detectSystemLocale(env = process.env): Locale {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return normalizeLocale(raw);
}
```

CLI 入口 `src/cli/index.tsx` 在 `resolveCtx()` 之后立即初始化一次；TUI 内切换不需要重启。

### 5. /lang slash 命令 + Ctrl+L

命令名 `/lang` 与参数枚举 `zh` / `en` / `auto` **保持英文**。

```
/lang zh    → setLocale("zh")
/lang en    → setLocale("en")
/lang auto  → setLocale("auto")
/lang       → 显示 preference + effective + 用法
```

`Ctrl+L` 注册为 keybinding ID `i18n.toggle`，只在 `zh ↔ en` 间切换；auto 需要 `/lang auto` 或 Settings 选择，避免用户误会快捷键会一直跟随系统语言。

### 6. UiI18nBridge

MiMo 的 UI package 通过 bridge 接收 `{ locale, t }`。chovy 的 `tui/kit`、`palette`、`screens` 也使用 bridge，不直接读取 config：

```ts
export interface UiI18nBridge {
  locale: () => string; // getIntlLocale()
  t: typeof t;
}
export function getUiI18nBridge(): UiI18nBridge;
```

### 7. format.ts

```ts
export function formatCost(usd: number): string {
  if (!loadConfig().i18n?.costInCNY) return `$${usd.toFixed(4)}`;
  return getLocale() === "zh" ? `￥${(usd * 7.2).toFixed(4)}` : `$${usd.toFixed(4)}`;
}
```

实时汇率会引入网络副作用，故不做；人民币折算默认关闭，用户可在 Settings → Language 打开。

## 接口冻结 / 不变量

- `Locale` 联合扩展只**追加**成员（如未来 `"zht"` / `"ja"`），不替换 `zh` / `en`。
- `LocalePreference` 固定包含 `"auto"`；新安装默认 preference 是 `"zh"`，不是 auto。
- `zh-CN` / `en-US` 是兼容 alias，不作为内部 `Locale` key。
- `t()` 签名冻结（B8）：返回值永远是 `string`，**不**抛；missing-key 走 warn + sentinel。
- 模板占位符统一 `{{ param }}`；不得混用 `{param}`。
- key 命名约定：`<domain>.<sub>.<concrete>`（英文小写、点分），不超 5 段，不夹空格。
- zh/en 最终 key 集合**必须严格相等**：`scripts/smoke-step32.ts` 跑 `Object.keys` 差集断言空。
- 以下**永远不进字典 value**：slash 命令名、CLI 子命令、Keybinding ID、Provider/Model/Theme/Field ID、Telemetry event type。
- slash 命令的描述走 i18n，key 形如 `slash.<name>.desc`。

## 验收标准

- `bun run typecheck` 通过；
- 无配置启动时 `getLocalePreference() === "zh"` 且 `getLocale() === "zh"`；
- `setLocale("en")` 后 `t("palette.title") === "Commands"`；
- `setLocale("zh-CN")` 被 normalize 成 `zh`；
- `setLocale("auto")` 且 `LANG=en_US.UTF-8` → effective locale 为 `en`；
- `t("header.cost", { cost: "$0.12" })` / `t("header.cost", { cost: "￥0.8640" })` 使用 `{{ cost }}` 正确替换；
- 命令面板 / help overlay 渲染：英文命令名 + 中文描述并列，如「`/goal` — 进入长程任务循环」；
- i18n 范围 smoke：字典 value 不含 `^/[a-z][a-z-]+$` 的 slash 字面量；
- `UiI18nBridge.locale()` 返回 `zh-Hans` 或 `en`，供 format / UI package 统一使用。

## 风险

- **新加 key 漏 en/zh**：CI 守门防回退；本地开发用 `scripts/i18n-check.ts` 自检。
- **alias 迁移混乱**：配置保存统一写 `zh` / `en` / `auto`；读取兼容旧 alias。
- **拼音首字母覆盖率**：`pinyin-initials.ts` 仅覆盖常用字；冷僻字 fallback 到原字符匹配。step-42 复用此表。
- **i18n 与主题无关**：locale 切换不应触发 theme 重算；两条事件流独立。
