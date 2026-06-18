# Step 08 — File System Tools（Read / Write / Edit / Glob / Grep）

**Phase**: B | **依赖**: 06 | **可并行**: ✅（与 09/10/11 并行） | **估时**: 6h

## 目标

实现 5 个最高频的文件系统工具，全部遵循 Tool Protocol v2，并尊重权限引擎与沙箱。

## 产物

```
src/tools/fs/
├── read.ts        # FileReadTool
├── write.ts       # FileWriteTool
├── edit.ts        # FileEditTool（精确字符串替换）
├── glob.ts        # GlobTool（基于 Bun.glob）
├── grep.ts        # GrepTool（包装 ripgrep；缺失则降级 fs walk）
└── index.ts
```

## 工具规范概览

| 名 | family | isReadOnly | 主要参数 |
|---|---|---|---|
| read | fs.read | ✅ | path: string, offset?, limit? |
| write | fs.mutate | ❌ | path, content |
| edit | fs.mutate | ❌ | path, oldString, newString, replaceAll? |
| glob | fs.read | ✅ | pattern, cwd? |
| grep | fs.read | ✅ | pattern, glob?, type?, output_mode?, -A/-B/-C |

## 关键实现要点

### 1. Read

- 文本文件直接返回；
- `cat -n` 行号格式（与 cc-haha 一致，便于用户复制行号）；
- 默认上限 2000 行；超出截断 + 提示 offset/limit；
- 读图片/PDF：本步暂仅返回 base64 + meta，**不**做 OCR/解析（留给 future）。
- `\n` 强制 LF 输出；写入时 `os.EOL` 还原。

### 2. Write

- 不存在时新建；存在时覆盖 → checkPermissions 提醒；
- 大于 1MB 拒绝；
- 受沙箱白名单约束（步骤 14）。

### 3. Edit

- 严格"唯一匹配"：oldString 必须出现且唯一，否则报错（与 cc-haha 一致）；
- `replaceAll: true` 替换全部；
- 同步刷新文件历史（供 cost-tracker 计算 +/- 行数）；
- 必须是已经被 Read 过的文件（在 ctx.session 维护文件 read set）—— 这一约束防止盲写。

### 4. Glob

- 使用 Bun 内置 `new Bun.Glob(pattern)`；
- 默认按 mtime 排序，限制返回 200 条；
- 自动过滤 `node_modules`、`.git` 等（可关闭）。

### 5. Grep

- 优先 spawn `rg`；
- 降级：纯 JS 行扫描（性能差但保证可用）；
- 模式：`files_with_matches`（默认）、`content`、`count`；
- 多行支持 `multiline: true`。

## 安全要点

- 所有路径必须经过 `safeFs` 与 `sandbox.assertWritable` / `sandbox.assertReadable`；
- 任何读写都生成 telemetry 事件 `tool.call`；
- Edit / Write 修改文件后写一个轻量"file-history"日志（在内存）供后续 cost 计算行差。

## ATP 描述（举例）

```ts
desc: {
  lean: 'Read a file. Returns numbered lines.',
  full: `Read a file from the local filesystem.\n\n- file_path must be absolute.\n- Reads up to 2000 lines by default.\n- Optionally specify offset/limit for long files.\n- Result uses cat -n format. ...`,
}
```

## 验收标准

- 5 个工具均能被 OpenAI provider 端到端调用（一次性 prompt 测试）；
- Edit 在缺少前置 Read 时返回明确错误；
- Grep 缺 ripgrep 时自动降级；
- 在 plan 模式下 Write/Edit 被权限引擎拒绝。

## 参考源

- `cc-haha/src/tools/FileReadTool/`、`FileEditTool/`、`FileWriteTool/`、`GlobTool/`、`GrepTool/`

## 风险

- ripgrep 二进制依赖 → 启动时探测；缺失 telemetry warn。
