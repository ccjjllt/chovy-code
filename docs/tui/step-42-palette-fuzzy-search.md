# Step 42 — 模糊搜索 + 中文分词 + 高亮

**Phase**: L | **依赖**: 41 | **估时**: 3h

## 目标

让命令面板搜索框支持：

- **英文模糊**：输入 "swm" 命中 "**S**witch **M**odel"；
- **中文 trigram**：输入 "切换" 命中所有含 "切换" 的项；
- **拼音首字母**：输入 "qhm" 命中 "**切**换**模**型"（i18n=zh 时启用）；
- **高亮命中字符**：在 PaletteRow label 上加 accent 色字符高亮。

## 产物

```
src/palette/
├── search.ts            # match / score / 高亮位置
├── highlight.tsx        # 渲染带高亮的文本
└── pinyin-match.ts      # 中文 → 拼音首字母（复用 i18n/pinyin-initials.ts）

scripts/smoke-step42.ts
```

## 实现要点

### 1. 评分函数

```ts
// src/palette/search.ts
export interface MatchResult {
  score: number;            // 越大越好；< 0 = 不匹配
  positions: number[];      // 命中的字符索引（用于高亮）
}
export function scoreMatch(label: string, query: string, locale: Locale): MatchResult;
```

策略：

1. **完全子串**：`label.toLowerCase().includes(query.toLowerCase())` → 高分（base 100）+ 子串靠前加 bonus；
2. **fuzzy 字符顺序**：query 字符按顺序在 label 出现 → 中分（base 50）+ 紧凑度 bonus（连续命中 +5）；
3. **拼音首字母**（locale=zh-CN 时）：把 label 的中文段抽出 → 取首字母 → 与 query 做 fuzzy → 中分（base 40）；
4. **trigram**：locale=zh-CN，query 长度 ≥ 2 时，按 2-gram / 3-gram 切片重叠匹配 → 低-中分（base 30）。

最终 score 取以上四策略的 max。低于 0 视为不匹配。

```ts
export function scoreMatch(label: string, query: string, locale: Locale): MatchResult {
  if (!query) return { score: 1, positions: [] };
  const a = scoreSubstring(label, query);
  const b = scoreFuzzy(label, query);
  const c = locale === "zh-CN" ? scorePinyinInitials(label, query) : { score: -1, positions: [] };
  const d = locale === "zh-CN" && query.length >= 2 ? scoreTrigram(label, query) : { score: -1, positions: [] };
  return [a, b, c, d].reduce((best, cur) => cur.score > best.score ? cur : best);
}
```

### 2. 拼音首字母匹配

```ts
// src/palette/pinyin-match.ts
import { initialsTable } from "../i18n/pinyin-initials.js";

export function toInitials(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x4E00 && cp <= 0x9FFF) {
      out += initialsTable.get(ch) ?? "";       // 缺失字符跳过
    } else if (cp <= 0x7F) {
      out += ch.toLowerCase();
    }
  }
  return out;
}
// "切换模型" → "qhmx"
```

`initialsTable` 是 `Map<string, string>`，覆盖 GB2312 一二级常用字（≈ 6700 字，~80KB JSON 编译进 bundle 后 gzip ~15KB）。
`step-32` i18n 模块已经维护了它，本步只引用。

### 3. 高亮渲染

```tsx
// src/palette/highlight.tsx
export function HighlightedLabel({ text, positions }: { text: string; positions: number[] }) {
  const theme = useTheme();
  if (positions.length === 0) return <Text>{text}</Text>;
  const set = new Set(positions);
  // 把 text 切成「普通段 / 高亮段」交替
  const parts: { text: string; hit: boolean }[] = [];
  let cur = "";
  let curHit: boolean | null = null;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (curHit === null || curHit === hit) { cur += text[i]; curHit = hit; }
    else { parts.push({ text: cur, hit: curHit }); cur = text[i]; curHit = hit; }
  }
  if (cur) parts.push({ text: cur, hit: curHit ?? false });
  return (
    <Text>
      {parts.map((p, i) => p.hit
        ? <Text key={i} bold color={theme.accent}>{p.text}</Text>
        : <Text key={i}>{p.text}</Text>
      )}
    </Text>
  );
}
```

替换 PaletteRow 中的 `<Text>{item.label()}</Text>` 为 `<HighlightedLabel text={item.label()} positions={result.positions}/>`。

### 4. debounce 80ms

```ts
// src/palette/state.ts 内：
export function setPaletteQuery(q: string) {
  _setRaw(q);                                   // 立刻反映到 input
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => _setSearchedQuery(q), 80);
}
```

input 显示 raw query（无延迟），过滤逻辑用 debounced query；输入快时不连续 reflow。

### 5. 排序 + 截断

```ts
export function filterAndSort(commands: PaletteCommand[], query: string, locale: Locale): { item: PaletteCommand; result: MatchResult }[] {
  const out: { item: PaletteCommand; result: MatchResult }[] = [];
  for (const c of commands) {
    const r = scoreMatch(c.label(), query, locale);
    if (r.score > 0) out.push({ item: c, result: r });
  }
  out.sort((a, b) => b.result.score - a.result.score);
  return out.slice(0, 50);                    // 最多展示 50 项
}
```

50 项硬上限：避免大量命令时 React 渲染卡顿；用户可继续输入精确化。

## 接口冻结 / 不变量

- `MatchResult.positions` 是**字符索引**（不是字节），与 string 的 codePoint 迭代一致；
- `scoreMatch` 单源 = `src/palette/search.ts`；其它模块**不**重新实现匹配逻辑；
- 拼音首字母仅在 `getLocale() === "zh-CN"` 时启用——避免 en-US 用户输入 "qhm" 看到无关项；
- debounce 80ms 写常量，不进 config。

## 验收标准

- `bun run typecheck` 通过；
- 单元（`scripts/smoke-step42.ts`）：
  - `scoreMatch("Switch Model", "swm", "en-US").score > 0`；positions 包含 0, 7（S 与 M 索引）；
  - `scoreMatch("切换模型", "qhmx", "zh-CN").score > 0`；
  - `scoreMatch("切换会话", "切换", "zh-CN").score > 0`；
  - `scoreMatch("打开编辑器", "qq", "zh-CN").score < 0`；
- 跑 chovy → Ctrl+P 输入 "切" → 列表过滤到含 "切" 的项；命中字符高亮蓝色；
- 输入 200 char 长 query 不卡顿（< 50ms 一次过滤）。

## 风险

- **拼音歧义**：多音字 → 用最常见读音（initialsTable 只存一个）；KNOWN-LIMITATIONS 注明。
- **高亮 React 渲染量**：50 项 × 每项 5 个高亮段 = 250 Text 节点，仍可接受（< 30ms）；超 50 项硬截断。
- **trigram 误匹配**：query="ab" 可能命中 "lab" "tab" 等无关项；策略 4 base score 最低，前 3 个匹配优先（顺序保证）。
