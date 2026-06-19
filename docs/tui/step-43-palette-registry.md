# Step 43 — 命令注册中心（推荐 / 分类 / 快捷键映射）

**Phase**: L | **依赖**: 41 | **可并行**: 42 | **估时**: 4h

## 目标

把所有可用命令收敛到一个 registry：

- 内置命令（核心 chovy 操作）；
- 既有 slash 命令同步注入；
- step-50/51 设置项可作为命令暴露（"打开主题设置 → ..."）；
- 推荐区按 MRU 排序；
- 分类按 i18n key 显示；
- `tui.palette.exec` telemetry 单源在此模块发射。

## 产物

```
src/palette/
├── registry.ts        # PaletteCommand 注册 / 查询
├── recent.ts          # MRU 持久化（~/.chovy/cache/palette-mru.json）
├── builtin.ts         # 默认命令集（~25 条）
└── group.ts           # filter + group + flatten
```

## 实现要点

### 1. PaletteCommand（B8 frozen extension）

```ts
// src/palette/registry.ts
export interface PaletteCommand {
  id: string;                     // 唯一，如 "session.switch"
  label: () => string;            // 调用时算（i18n 切换后即时生效）
  category: PaletteCategory;
  hotkey?: string;                // 显示用，从 keybindings 单源拿
  run: (ctx: ReplCtx) => Promise<void> | void;
  predicate?: (ctx: ReplCtx) => boolean;     // 条件可见
  /** 关键字增强：例如 "model" 注册英文 + "模型" 中文，提升搜索命中 */
  aliases?: string[];
}
export type PaletteCategory = "recommend" | "session" | "model" | "theme" | "settings" | "tools" | "buddy";
```

注册：

```ts
const _store: Map<string, PaletteCommand> = new Map();
export function registerCommand(c: PaletteCommand): void {
  if (_store.has(c.id)) throw new ChovyError("INTERNAL", `duplicate palette command: ${c.id}`);
  _store.set(c.id, c);
}
export function getCommands(ctx: ReplCtx): PaletteCommand[] {
  return [..._store.values()].filter(c => !c.predicate || c.predicate(ctx));
}
```

### 2. 默认命令集（builtin.ts，约 25 条）

| id | category | hotkey id | run（简述） |
|---|---|---|---|
| `session.switch` | session | `session.switch` | 列出 thread 历史让用户选 |
| `session.new` | session | `session.new` | 重置消息列表 |
| `model.switch` | model | `model.switch` | 调出 model 选择器 |
| `provider.switch` | model | – | 调出 provider 选择器 |
| `mode.toggle` | session | – | 切 permission mode |
| `theme.next` | theme | – | 切到下一个内置主题 |
| `theme.settings` | theme | – | 跳设置界面 theme tab |
| `lang.toggle` | settings | `i18n.toggle` | zh ↔ en |
| `settings.open` | settings | `settings.open` | 打开 SettingsScreen |
| `tools.list` | tools | – | 显示已注册工具 |
| `agents.list` | tools | – | 显示活跃 sub-agent |
| `mem.search` | tools | – | 进入 memory search 模式 |
| `goal.start` | tools | – | 提示输入 goal objective |
| `checkpoint.now` | tools | – | 立即触发 checkpoint |
| `buddy.pet` | buddy | `buddy.pet` | 摸吉祥物 |
| `buddy.mute` | buddy | – | 静音切换 |
| `buddy.skin` | buddy | – | 列出皮肤 |
| `help.toggle` | settings | `help.toggle` | 切换帮助浮层 |
| `repl.clear` | session | – | 清屏 |
| `quit` | settings | – | 退出 chovy |

剩余 5 条留给 slash 命令同步注入（step-44）。

### 3. MRU 持久化

```json
// ~/.chovy/cache/palette-mru.json
{
  "items": {
    "model.switch": { "count": 12, "lastUsedAt": 1718800000000 },
    "session.new":  { "count":  3, "lastUsedAt": 1718700000000 }
  },
  "v": 1
}
```

排序公式（含衰减）：

```ts
function mruScore(count: number, lastUsedAt: number, now: number): number {
  const ageDays = (now - lastUsedAt) / 86_400_000;
  return count * Math.exp(-ageDays / 30);     // 30 天半衰期
}
```

`getRecommended(): PaletteCommand[]` 返回 score 排序前 5 项。

### 4. group.ts — filter + group + flatten

```ts
export interface Group { id: PaletteCategory; items: { item: PaletteCommand; result: MatchResult }[]; }
export function groupAndFilter(commands: PaletteCommand[], query: string, ctx: ReplCtx): Group[] {
  const filtered = filterAndSort(commands, query, getLocale());
  const groups = new Map<PaletteCategory, Group>();
  // 当 query 空：第一个 group 是 recommend，含 MRU 前 5
  if (query.trim() === "") {
    const rec = getRecommended().map(it => ({ item: it, result: { score: 1000, positions: [] } }));
    if (rec.length > 0) groups.set("recommend", { id: "recommend", items: rec });
  }
  for (const f of filtered) {
    const cat = f.item.category;
    if (!groups.has(cat)) groups.set(cat, { id: cat, items: [] });
    groups.get(cat)!.items.push(f);
  }
  return [...groups.values()];
}
```

分组顺序：`recommend → session → model → theme → tools → settings → buddy`（写常量数组，不进 config）。

### 5. 执行 + telemetry

```ts
export async function execAt(flat: { item: PaletteCommand; result: MatchResult }[], idx: number, ctx: ReplCtx): Promise<void> {
  const entry = flat[idx];
  if (!entry) return;
  const item = entry.item;
  closePalette();
  bumpMru(item.id);
  emit({ type: "tui.palette.exec", id: item.id, locale: getLocale() });   // 单源
  try { await item.run(ctx); }
  catch (err) {
    logger.warn(`palette ${item.id} failed: ${err}`);
    ctx.appendSystem(`命令 ${item.id} 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
```

### 6. hotkey 文本同步

```ts
function hotkeyTextFor(c: PaletteCommand): string | undefined {
  if (!c.hotkey) return undefined;
  return getBinding(c.hotkey);   // 当前生效 key（含用户 override）
}
```

PaletteRow 渲染时调用此函数，确保用户改了快捷键后面板**立即**反映。

## 接口冻结 / 不变量

- `PaletteCommand` 字段冻结；扩展只追加。
- `tui.palette.exec` telemetry 单源在 `execAt`；其它模块**禁止**直发。
- registerCommand duplicate-id 抛 INTERNAL（与 tools/registry.ts 同纪律）。
- MRU 文件失败（写 / 读）→ warn + 用空 store，**不**让 palette 拒绝打开。
- 50-命令上限（step-42）+ 5-推荐上限（本步）：超出按 score 截断。

## 验收标准

- `bun run typecheck` 通过；
- `scripts/smoke-step43.ts`：注册 5 条命令 → query="" 看到 recommend 区为空（无 MRU）；exec 一次后再 query="" 看到 recommend 含该项；
- chovy + Ctrl+P → 看到 recommend / session / model / settings 多个分组；分组标题中文（zh-CN）；
- exec 一条命令 → 关闭 palette + telemetry 写一条 `tui.palette.exec`；
- 打开命令面板时 hotkey 列与 step-34 当前生效键一致（改 keybinding 后立即变）。

## 风险

- **command 注册时机**：必须在 REPL 挂载**前**完成；否则首次 Ctrl+P 列表为空。`builtin.register()` 在 `cli/index.tsx` 顶层调用一次。
- **predicate 副作用**：`predicate(ctx)` 不应做 I/O；纯 boolean。
- **MRU 文件竞态**：多 chovy 进程并发写 mru.json → 用 atomic write（写 tmp + rename），失败 fallback 为只读最新版。
