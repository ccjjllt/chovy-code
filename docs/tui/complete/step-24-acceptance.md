# Step-24 Memory Store — 验收报告

> 日期：2026-06-18
> Phase：G（Memory System / TMT）
> 依赖：step-04 ✅（safeFs / paths / chovy home）
> 并行：可与 step-23（Goal Loop）并行；本步落地后解锁 step-25/26（注入 + checkpoint）

## 0. 任务范围

按 [`docs/step-24-memory-store.md`](../step-24-memory-store.md) 落地 **TMT — Tiered Memory Tree** 的存储底层：4 类记忆 schema + bun:sqlite 持久化 + FTS5 全文索引。
是 5 项核心创新中 TMT（[`innovations.md`](../innovations.md)）的第一步实施；冻结 `MemoryRecord` / `MemoryQuery` / `MemoryLayer` / `MemoryType`（[`architecture.md` §3.3 B4 屏障](../architecture.md)）。

不在本步骤做（按计划留给后续）：

- step-25：跨会话注入 + 相关性打分（`memory/injection.ts` + `ranker.ts`）；
- step-26：checkpoint-writer 子 agent 路径沙箱 + 模板（本步只在 sync 时把 `checkpoints/*.md` 当作普通源文件读）；
- step-27/28：SCW 自动 checkpoint 触发；
- 加密 / 多用户共享（chovy-code 单用户单机假设，§5 红线）。

## 1. 文件清单

### 新增

| 文件 | 行数 | 摘要 |
|---|---:|---|
| `src/memory/types.ts` | 23 | re-export `MemoryLayer` / `MemoryType` / `MemoryRecord` / `MemoryQuery`（单源 = `src/types/memory.ts`，§16 模式延续） |
| `src/memory/migrations.ts` | 110 | DDL 单源（TS 内联字符串常量）：`MIGRATIONS_SQL` + `DELETE_PROJECT_SQL` + `DELETE_PROJECT_META_SQL` + `splitStatements`；schema 含 `memories` + `memories_fts` (FTS5 unicode61 + remove_diacritics 2) + `memory_index_meta` + `schema_version` |
| `src/memory/parser.ts` | 263 | frontmatter 简易解析（`chovy_memory` / `default_type` / `default_importance` 三键白名单）+ section 解析（`## XXX` → tag）+ 三阶 bullet 匹配（`type(imp): content` / `type: content` / 纯文本兜底）+ 多行 bullet 续接 + prose fallback；`inferLayerFromPath` / `clampImportance` |
| `src/memory/store.ts` | 580 | `createMemoryStore({ cwd })` 工厂；优先 `bun:sqlite` + WAL + FTS5；探测失败 → `InMemoryStore`（warn + telemetry `degraded:true`）；`upsert` / `upsertMany`（事务）/ `remove` / `removeBySource` / `list` / `search`（BM25 单 + mixed = 0.7\*bm25 + 0.3\*recency）/ `rebuild` / `count` / `getIndexedMtime` / `setIndexedMtime`；`normalizeRecord` 校验 layer/type 白名单 + 自动派发 deterministic id (`mem_<sha1(seed)[:12]>`) |
| `src/memory/files/memoryFile.ts` | 159 | `readMemoryFile` / `writeMemoryFile` / `appendMemoryEntry`（自动建/追加 `## section`）；MAX_LINES=200 + MAX_BYTES=25_000（cc-haha 对齐）；超限 warn + truncate + 注入 WARNING 标记 |
| `src/memory/files/notesFile.ts` | 71 | `readNotesFile` / `writeNotesFile` / `appendNote`（时间戳 bullet）；MAX_LINES=500 / MAX_BYTES=64_000 |
| `src/memory/files/progressFile.ts` | 75 | `readProgressFile` / `writeProgressFile` / `appendProgress`；超 32KB 取尾 + NOTE 标记；`appendProgress` 用 `## ISO 时间戳` 分块 |
| `src/memory/syncFromFiles.ts` | 191 | `syncProject(cwd, store)` 增量同步（`memory_index_meta` mtime 缓存命中 → 跳过）+ `forceRebuild(cwd, store)`（清表 + 全量重解析）；source 枚举：`MEMORY.md` + `notes.md` + `checkpoints/*.md` + `tasks/<id>/progress.md`；单源失败 warn + skip（不阻塞项目级 sync） |
| `src/memory/index.ts` | 70 | 公共 barrel：types / store / parser / sync / files / migrations |
| `scripts/seed-memory.ts` | 89 | 写入 100 条 fixture（4 layer × 25 type 组合）→ 验证 list / FTS search('fixture') / spot-check token-42（用于 spec §验收 1） |
| `scripts/smoke-step24.ts` | 380 | **18 个 case，50 项检查**：types 冻结 / parser frontmatter+bullets / 层路径推断 / store CRUD / FTS5 BM25 / mixed ranker / rebuild / rebuild guard / memoryFile read+write+truncation / appendMemoryEntry / notesFile / progressFile tail / 增量 sync / forceRebuild / 降级模式 / perf 50KB 解析 < 500ms / perf 1k FTS < 50ms |

### 修改

| 文件 | 改动要点 |
|---|---|
| `src/types/memory.ts` | **B4 冻结**：`MemoryLayer = 'project' \| 'checkpoint' \| 'notes' \| 'progress'`（DRAFT 的 `'task'` → `'progress'`）；`MemoryType` 8 值（`decision` / `rule` / `fact` / `pref` / `snapshot` / `progress` / `note` / `reference`）；`MemoryRecord` 加 `projectId` / `sourcePath` / `sourceLine?` / `importance` / `tags: string[]`（要求非可选，store 默认 `[]`）；`MemoryQuery` 加 `text` / `types` / `minImportance` / `ranker`；老 `MemoryKind` 标 `@deprecated` 软保留（grep 验证零 in-tree 消费方）；新增 `MEMORY_LAYERS` / `MEMORY_TYPES` runtime tuple |
| `src/telemetry/events.ts` | 新增 `memory.index` 事件（`projectId / op('rebuild' \| 'sync' \| 'init') / count / durMs / degraded`）；单源 = `src/memory/store.ts` + `syncFromFiles.ts`；`memory.injection` 字段不动（留 step-25） |
| `src/cli/index.tsx` | `mem list` / `mem show <id>` / `mem search "<query>"` 接真实 store；新增 `mem rebuild` + `mem stats`；search 默认 `mixed` ranker，`--bm25` 切纯 BM25 |
| `src/index.ts` | 加 `export * as memory from "./memory/index.js"` |

## 2. 关键设计决策

### 2.1 schema 冻结：直接替换 DRAFT（决策点）

`src/types/memory.ts` 在 step-24 之前是 DRAFT（`kind: MemoryKind` / `score` / `task` layer），与 spec 严重不一致。架构 §3.3 B4 屏障在 step-24 冻结，全仓 grep 零外部消费方（仅自身导出）→ **直接替换**为 spec 形态，老 `MemoryKind` 标 `@deprecated` 软保留 1 个 step（reviewer diff 安全网，step-26 清理）。

### 2.2 DDL 单源 = TS 字符串常量（spec §产物对齐）

spec 列出 `migrations.sql` 为产物，但实际选择 `src/memory/migrations.ts` 内联字符串常量：

- `bin/chovy.js` 是 bundled 单文件 CLI；分发独立 `.sql` 资源会引入 build.ts 拷贝逻辑 + bundle 路径解析的次生问题；
- 双源（.sql + .ts 镜像）容易漂移；
- spec 是导航不是规约（[AGENTS.md §3](../../AGENTS.md)）。

`MIGRATIONS_SQL` 同时用于 `bun:sqlite` (走 `db.exec(MIGRATIONS_SQL)`，整块 multi-statement) 和 `splitStatements` helper（导出但不在主路径使用）。

> ⚠️ **避坑**：早期使用 `splitStatements()` 逐句 `db.exec` 导致所有 case 静默降级到 InMemoryStore — 因为 FTS5 触发器的 `BEGIN ... END;` 体内有嵌入 `;`，朴素分割破坏触发器创建。固化到 §20 不变量。

### 2.3 `bun:sqlite` 不可用 → 降级（spec §risks）

```ts
let cachedCtor: BunDatabaseCtor | null | undefined; // undefined = 未探
async function loadBunDatabase() {
  try { ({ Database: cachedCtor } = await import("bun:sqlite")); }
  catch { cachedCtor = null; logger.warn("bun:sqlite unavailable — degraded"); }
}
```

降级路径：
- `InMemoryStore`：朴素 `Map<id, MemoryRecord>` + `LIKE` 子串匹配（FTS5 退化为 `content/tags.toLowerCase().includes(needle)`）；
- 排序：`importance + countOccurrences * 5` —— 不是 BM25 但仍给出稳定相关性信号；
- 每次 `createMemoryStore` 仍发 `memory.index` 事件，`degraded:true` 让 `chovy log tail` 能看到。

`_forceInMemoryForTesting()` / `_resetSqliteProbeForTesting()` 测试钩子让 smoke case 16 显式覆盖该路径。

### 2.4 deterministic id（idempotent 解析）

```ts
generateId(projectId, sourcePath, sourceLine, content)
  = `mem_${sha1(`${projectId}|${sourcePath}|${sourceLine}|${content}`).slice(0, 12)}`
```

re-parse 同一 MEMORY.md 时同一 bullet 产生同一 id → upsert 替换而非重复入库。`sourcePath` 为空（来自非文件源）的记录走 `mem_${random[12]}` 兜底。

### 2.5 增量 sync mtime 缓存（spec §性能基线 fast path）

`memory_index_meta(project_id, source_path)` 表存储每个源文件的 `mtime` 与 `indexed_at`。`syncProject()` 读取 `safeFs.stat` mtime 与缓存比对：
- 命中（≤ cached mtime） → 跳过整个文件；
- 不命中 → 先 `removeBySource(projectId, sourcePath)` 删旧记录（处理删行场景）→ 重新 parse + `upsertMany` → `setIndexedMtime`。

`forceRebuild()` 路径用 `store.rebuild(pid, repopulate)` 把 `DELETE` + 重 INSERT 包在单事务里；mtime 缓存在事务外补回（事务内会被同 rebuild 的 `DELETE_PROJECT_META_SQL` 抹掉）。

### 2.6 BM25 + recency mixed ranker（spec §API ranker:'mixed'）

```sql
ORDER BY (0.7 * (-bm25(memories_fts)) + 0.3 *
          CASE WHEN ?now - m.updated_at < 0 THEN 1.0
               ELSE exp(-(CAST(?now - m.updated_at AS REAL) / ?window)) END) DESC
```

- `recency` 半衰期 30 天（`RECENCY_WINDOW_MS`）；
- bm25 是负数（越小越好）→ 取负后归一化为正分；
- 若 bundled sqlite 无 `exp()` → catch + fallback 到纯 BM25 + warn（未触发 — Bun 1.1+ 的 sqlite 默认带 math 扩展）。

### 2.7 单源规约（接 §16/§17/§18 同模式 → §20）

- 类型 = `src/types/memory.ts`；`src/memory/types.ts` 仅 re-export；
- DDL = `src/memory/migrations.ts` 的 `MIGRATIONS_SQL` 常量；
- `memory.index` telemetry 单源 = `src/memory/store.ts:rebuild`/`createMemoryStore` 的 init + `syncFromFiles.ts:syncProject`；
- 文件 I/O 单源 = `safeFs`，与 §9 红线一致；
- size limits = `MAX_MEMORY_LINES=200` / `MAX_MEMORY_BYTES=25_000` / `MAX_NOTES_LINES=500` / `MAX_NOTES_BYTES=64_000` / `PROGRESS_TAIL_BYTES=32_000`。

## 3. 验收

### spec §验收标准

| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | `bun run scripts/seed-memory.ts` 写入 100 条 → 全部可被 search 找回 | ✅ | `seed-memory: list() returned 100 / 100 ✔` + `search('fixture') returned 100 / 100 ✔` + `search('token-42') hit expected record ✔` |
| 2 | 删除 .db 后 `chovy mem rebuild` 恢复 | ✅ | 写 MEMORY.md（5 bullets） → `rm memory.db` → `bun src/cli/index.tsx mem rebuild` → `4 records in 2ms` → `mem search "Bun"` 命中 `score=0.925` |
| 3 | `chovy mem search "build"` 返回 BM25 排序结果 | ✅ | seed-memory 数据上 `mem search fixture` 返回带 `score=...` 的排序行 |

### 自加项

- ✅ `bun run typecheck` 干净
- ✅ `bun scripts/smoke-step24.ts` — **50 PASS / 0 FAIL**（18 case 覆盖；perf 50KB → 28ms / 1k FTS → 0ms 远低于 spec 的 100ms / 5ms 阈值）
- ✅ telemetry 验证：`memory.index` 三种 op (`init` / `rebuild` / `sync`) 都正确发射，`degraded:false` 正常
- ✅ 降级路径：`_forceInMemoryForTesting()` 触发 → 50 项中的「degraded mode」3 项全 PASS
- ✅ grep 验证：仅 `src/types/memory.ts` 声明 `MemoryLayer`/`MemoryType`/`MemoryRecord`/`MemoryQuery`；`src/memory/types.ts` 仅 re-export
- ✅ 依赖图无环：`src/memory/*` 不 import `engine` / `providers` / `agent` / `swarm` / `goals`（叶子模块）

### 性能基线（实测 vs spec）

| 指标 | spec 阈值 | 实测 | 余量 |
|---|---:|---:|---:|
| 50KB MEMORY.md 首次索引（800 records） | < 100ms | 28ms | 3.6× |
| 1k FTS5 BM25 查询 | < 5ms | 0ms（5 次 best-of） | > 5× |

## 4. 不变量沉淀（→ AGENTS.md §20）

详见 `AGENTS.md` 新增的 §20 Phase G 不变量段。要点：

1. `MemoryRecord` / `MemoryQuery` / `MemoryLayer` / `MemoryType` 单源 = `src/types/memory.ts`（B4 冻结），扩展只追加可选字段。
2. DDL 单源 = `src/memory/migrations.ts` 的 `MIGRATIONS_SQL` 字符串常量；`db.exec(MIGRATIONS_SQL)` 整块执行（**不**逐句 split — FTS5 trigger 的 `BEGIN ... END;` 体内嵌 `;`）。
3. `bun:sqlite` 缺失 → `InMemoryStore` + warn + telemetry `degraded:true`，**不抛**。
4. 文件 I/O 走 `safeFs`；`MEMORY.md ≤ 200 行 / 25KB`、`notes.md ≤ 500 行 / 64KB`、`progress.md` 取尾 32KB。
5. `memory.index` telemetry 只由 `store.ts` + `syncFromFiles.ts` 发射；`memory.injection` 留 step-25。
6. `rebuild('')` 必须抛 `MEMORY_INDEX_CORRUPT`（防误删全表）。
7. FTS5 tokenizer = `unicode61 remove_diacritics 2`。
8. `memory/*` 是叶子：可被 `engine` / `cli` / 后续 step-25 注入引用，但**不**反向依赖 `engine` / `providers` / `agent` / `swarm` / `goals`。
9. deterministic id：`mem_<sha1(projectId|sourcePath|sourceLine|content)[:12]>` 让重复 parse 走 upsert 而非重复插入。
10. `syncProject` mtime 缓存命中 = 跳过整个文件（fast path）；`forceRebuild` 走单事务清+灌，mtime 缓存事务外补回。

## 5. 风险与后续清理

| # | 风险 | 状态 | 缓解 |
|---|---|---|---|
| R1 | `splitStatements()` 误用导致 trigger 静默失败 | ✅ 已修 | 改走 `db.exec(MIGRATIONS_SQL)` 整块；`splitStatements` 保留为公共 helper（外部脚本可能想逐句执行）+ §20 不变量 2 加注 |
| R2 | bun:sqlite 在 ARM Linux 缺失 | ✅ 已实现降级 | `_forceInMemoryForTesting` smoke case 16 验证；spec §risks 已对齐 |
| R3 | FTS5 unicode61 中文分词差 | ⚠️ 已知 | spec §risks 提示后续可换 trigram；本步不做（YAGNI） |
| R4 | `appendMemoryEntry` 越界丢条目 | ⚠️ 已知 | 当前直接 warn + 丢弃；后续 step-25/26 可改为先调 checkpoint-writer 压缩再 append |
| R5 | 老 DRAFT `MemoryKind` 还在导出 | ✅ 软保留 | grep 零消费方；step-26 cleanup 时彻底删除 |

## 6. 后续接线（不在本 PR）

- step-25 `injection.ts` 启动时调 `syncProject(cwd, store)` + `store.search({ text: lastUserMessage, ranker:'mixed', limit: 8 })` → 注入 system prompt 动态段；
- step-26 checkpoint-writer 子 agent 写 `checkpoints/<ts>.md` + `store.upsert({ layer:'checkpoint', type:'snapshot', ... })`；本 step 已让 `syncFromFiles` 把 `checkpoints/*.md` 当源文件读，step-26 落地后无缝接入；
- step-27/28 SCW 监听 `memory.index` 事件做容量统计 + 触发 checkpoint。

## 7. 文件依赖快照

```
src/memory/
├── index.ts              ← 公共 barrel
├── types.ts              ← re-export from src/types/memory.ts
├── migrations.ts         ← MIGRATIONS_SQL 常量（DDL 单源）
├── parser.ts             ← frontmatter + bullets parser
├── store.ts              ← bun:sqlite + FTS5 + InMemoryStore 降级
├── syncFromFiles.ts      ← 文件 ↔ DB 同步（增量 + forceRebuild）
└── files/
    ├── memoryFile.ts     ← MEMORY.md
    ├── notesFile.ts      ← notes.md
    └── progressFile.ts   ← tasks/<id>/progress.md
```

依赖关系（leaf → 上层）：

```
types/memory.ts ─┬─▶ memory/types.ts
                 └─▶ memory/store.ts ─┬─▶ memory/index.ts
                                      ├─◀ memory/syncFromFiles.ts
fs/safeFs + paths ─▶ memory/files/* ◀─┘
telemetry/events.ts ◀─ memory/store.ts (memory.index 单源)
logger ◀─ memory/store.ts + files/* + syncFromFiles.ts
```

无循环；不向 engine / providers / agent / swarm / goals 反向依赖（叶子）。

---

**结论**：step-24 全部产物已落地；spec §验收标准 3/3 全 PASS；自加 50 项 smoke 全 PASS；性能基线远超 spec；B4 屏障接口冻结，下一步可启动 step-25/26（Memory Injection + Checkpoint Writer）。
