# Step 24 — Memory Store（bun:sqlite + FTS5 + 4 类记忆）

**Phase**: G | **依赖**: 04 | **可并行**: ✅（与 23 并行） | **估时**: 6h

## 目标

实现 **TMT — Tiered Memory Tree** 的存储底层：4 类记忆 schema + bun:sqlite 持久化 + FTS5 全文索引。
此后 step-25/26 在其上做注入与自动 checkpoint。

## 产物

```
src/memory/
├── store.ts            # SQLite 操作 + 索引重建
├── types.ts            # MemoryRecord / Layer / Type
├── files/
│   ├── memoryFile.ts   # MEMORY.md 读写 + 解析
│   ├── notesFile.ts
│   └── progressFile.ts
├── parser.ts           # frontmatter / section 解析
├── migrations.sql
└── index.ts
```

## 4 类记忆

```ts
export type MemoryLayer = 'project' | 'checkpoint' | 'notes' | 'progress';

export type MemoryType =
  | 'decision'       // 架构决策
  | 'rule'           // 编码规范
  | 'fact'           // 事实信息（环境、约束）
  | 'pref'           // 用户偏好
  | 'snapshot'       // checkpoint 内容
  | 'progress'       // 任务日志
  | 'note'           // 临时笔记
  | 'reference';     // 外部资源指针

export interface MemoryRecord {
  id: string;                 // 'mem_' + base36
  projectId: string;
  layer: MemoryLayer;
  type: MemoryType;
  sourcePath: string;         // MEMORY.md / checkpoints/x.md / notes.md / tasks/<id>/progress.md
  sourceLine?: number;
  content: string;
  tags: string[];
  importance: number;         // 0–100
  createdAt: number;
  updatedAt: number;
}
```

## SQLite Schema

```sql
-- migrations.sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_line INTEGER,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_mem_project ON memories(project_id, layer, type);
CREATE INDEX idx_mem_importance ON memories(importance DESC, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, tags, content='memories', content_rowid='rowid'
);

-- triggers 同步
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
```

## 文件 ↔ DB 同步

文件是 *主源*：

- 启动时检测 `mtime(MEMORY.md) > lastIndexedAt(project)` → 重新解析并 upsert；
- 写入时（来自 MemoryWriteTool 或 checkpoint-writer）先写文件再 upsert；
- 索引可被破坏（用户手改 + 极端情况）→ `chovy mem rebuild`：清表重建。

## API

```ts
export interface MemoryStore {
  upsert(rec: MemoryRecord): Promise<void>;
  remove(id: string): Promise<void>;
  list(filter?: { layer?: MemoryLayer; type?: MemoryType; limit?: number }): Promise<MemoryRecord[]>;
  search(query: MemoryQuery): Promise<MemoryRecord[]>;
  rebuild(projectId: string): Promise<{ count: number }>;
}

export interface MemoryQuery {
  text?: string;            // FTS5 查询
  layers?: MemoryLayer[];
  types?: MemoryType[];
  minImportance?: number;
  limit?: number;
  /** 启用 BM25 + recency mix; weight = bm25 * 0.7 + recency * 0.3 */
  ranker?: 'bm25' | 'mixed';
}
```

## 解析 MEMORY.md

支持简易 frontmatter：

```markdown
---
chovy_memory: true
default_type: decision
default_importance: 60
---

## Architecture

- decision(80): we use Bun + Ink, not Node
- rule(70): commit messages must follow conventional-commits
- fact(50): production deploy is via GitHub Actions on tag push

## Code style

- rule: prefer explicit return types in TS
```

解析器把每个 `- type(importance): content` 转成 MemoryRecord。
不写 type 时用 default_type。
未解析的段落作为 layer=project, type=fact, importance=40 入库（保底）。

## 文件大小限制

- MEMORY.md：≤ 200 行 / 25 KB（与 cc-haha 一致）；超出在 prompt 中显式提示用户；
- notes.md：≤ 500 行（agent 自管）；
- progress.md：无硬限，但分段截断；
- checkpoints/*.md：各 ≤ 8 KB。

## 性能基线

- 首次索引 50 KB MEMORY.md：< 100ms；
- FTS5 查询 1k 条记录：< 5ms；
- 文件 mtime 检测无变化时跳过解析（fast path）。

## 验收标准

- `bun run scripts/seed-memory.ts` 写入 100 条 → 全部可被 search 找回；
- 删除 .db 后 `chovy mem rebuild` 恢复；
- `chovy mem search "build"` 返回 BM25 排序结果。

## 参考源

- `cc-haha/src/memdir/memdir.ts`、`memoryTypes.ts`、`memoryScan.ts`、`findRelevantMemories.ts`

## 风险

- bun:sqlite 在某些 Linux ARM 缺失 → 降级为内存存储（启动 telemetry warn）；
- FTS5 中文分词差 → 默认 unicode61 + 配置 `tokenize='unicode61 remove_diacritics 2'`；后续可换 trigram。
