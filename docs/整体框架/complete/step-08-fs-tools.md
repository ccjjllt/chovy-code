# Step 08 完成报告 — File System Tools（Read / Write / Edit / Glob / Grep）

- **Phase**: B（Tool System v2）
- **依赖**: 06（B1 屏障——`Tool` v2 接口 + `ToolResult` + `family` + `checkPermissions` + 注册中心 `namespace` + ATP `describeTools`）
- **B 屏障**: ✅ 本步是 B 阶段并行项之一（与 09/10/11 同级），不引入新屏障；step-06 已落地后 step-08 顺位实现
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-08-fs-tools.md`](../step-08-fs-tools.md)
- **关联创新**:
  - **ATP**：5 个工具全部填齐 `desc.lean / desc.full / examples`、`family: "fs"`、`fullTriggers` 留空（由 step-07 决定何时升级）
  - **SCW（前置基建）**：每个 `ToolResult.meta` 都填了 `bytes` / `durMs` / `filesChanged`，供 step-16 `costTracker` 与 step-27 上下文阈值监控直接消费
  - PCM / TMT / SwarmR / CSG — 本步未直接耦合

---

## 1. 目标回顾

实现 5 个最高频的文件系统工具，全部遵循 Tool Protocol v2，并为权限引擎（step-12）与沙箱（step-14）预留接口。`docs/step-08-fs-tools.md` 给定的工具规范概览：

| 名 | family | isReadOnly | 主要参数 |
|---|---|---|---|
| `file_read`  | fs | ✅ | path, offset?, limit? |
| `file_write` | fs | ❌ | path, content |
| `file_edit`  | fs | ❌ | path, oldString, newString, replaceAll? |
| `glob`       | fs | ✅ | pattern, cwd?, noIgnore?, limit? |
| `grep`       | fs | ✅ | pattern, path?, glob?, type?, output_mode?, before/after/context, multiline, caseInsensitive, limit? |

---

## 2. 产物清单

### 2.1 新建文件

| 路径 | 行数（约） | 作用 |
|---|---|---|
| `src/tools/fs/fileHistory.ts` | 110 | 模块级 read-set + 修改日志：`markRead` / `wasRead` / `recordChange` / `getHistory` / `lineDelta` / `_resetFileHistoryForTesting`；step-16 时整体迁到 `ctx.session.fileHistory`（接口签名不变） |
| `src/tools/fs/read.ts`        | 200 | `file_read`：cat -n 格式（6-char 行号 + tab）、2000 行默认 / 5000 硬上限、绝对路径强校验、CRLF/CR 归一为 LF、二进制扩展名清单转 stub、命中 `markRead()` |
| `src/tools/fs/write.ts`       | 165 | `file_write`：`safeFs.write` 原子写、1 MiB 上限、写前 read（best-effort）算行差、`recordChange()` + `markRead()`、`meta.filesChanged` |
| `src/tools/fs/edit.ts`        | 220 | `file_edit`：绝对路径 + `wasRead()` 盲写守卫、唯一匹配 / `replaceAll`、`split.join` 精确替换、`safeFs.write` 原子化、行差落到 `fileHistory` |
| `src/tools/fs/glob.ts`        | 200 | `glob`：`Bun.Glob.scan({ onlyFiles, dot:false })`、`cwd` 默认 `process.cwd()`、内建忽略集（`node_modules / .git / .svn / .hg / dist / build / .next / .turbo / .cache / .chovy / coverage / .venv / __pycache__`）、mtime 降序、200 hard cap（4× 拉满后再截取）|
| `src/tools/fs/grep.ts`        | 380 | `grep`：ripgrep 子进程优先 + 纯 JS 行扫描降级；3 种 `output_mode`（`files_with_matches` / `content` / `count`）；`-A / -B / -C`、`multiline`、`glob` / `type`（rg-only）、`caseInsensitive`；`detectRipgrep()` 首调用探测 + 缓存 + 一次性 `logger.warn` |
| `src/tools/fs/index.ts`       | 25 | barrel：导出 5 工具对象 + `fileHistory` 公开符号 + `_resetRipgrepProbeForTesting` |
| `scripts/smoke-fs-tools.ts`   | 100 | 开发期冒烟脚本：16 条断言覆盖创建 / 读取 / 编辑（唯一/含糊/replaceAll/盲写）/ glob / grep（3 mode + 无匹配）/ 1 MiB 拒绝；不入产物链 |
| `docs/complete/step-08-fs-tools.md` | 本文件 | 完成报告 |

### 2.2 改动文件

| 路径 | 改动要点 |
|---|---|
| `src/tools/index.ts` | 新增 5 行 `registerTool(<fsTool>, { namespace: "fs" })`；保持 echo 注册不变；保持公开 barrel 不变 |
| `src/tools/registry.ts` | `registerTool` 由非泛型升级为 `registerTool<T extends z.ZodType>(tool: Tool<T>, opts?)`，并在存储时单点 `as unknown as Tool` 抹去窄泛型。理由：`Tool<T>` 的 `T` 在 `schema: T` 与 `z.infer<T>` 中同时出现 → 不变；不改注册器签名的话 `Tool<ZodObject<...>>` 无法赋给 `Tool<ZodType>`。这是 step-06 收尾的小漏洞，与 step-08 同 PR 修掉 |
| `src/types/messages.ts` | （linter 自动）将旧 wire `ToolResult { callId, ok, output }` 重命名为 `ToolCallResult`，避免与 step-06 v2 `tool.ts:ToolResult` 通过 `types/index.ts` 的 `export *` 撞名。step-06 完成报告已记录这一改名 |

### 2.3 未触碰的文件（避免越界）

- `src/types/tool.ts`（B1 接口冻结点，本步消费而不修改）
- `src/types/errors.ts`（`TOOL_INVALID_ARGS / TOOL_DENIED / MEMORY_IO / INTERNAL` 全部已存在，零新增）
- `src/types/index.ts`（barrel 自动重导出，无需手改）
- `src/tools/echo.ts` / `src/tools/describe.ts`（step-06 产物，本步不动）
- `src/agent/agent.ts`（step-06 已加 `string | ToolResult` 兼容层，本步无须改）
- `src/cli/*`（CLI 行为不变；新 fs 工具在 REPL 中通过现有调用栈自动可见）
- `src/fs/safeFs.ts` / `src/fs/paths.ts`（**有意未扩 `readBytes` API**——二进制支持的小坑留给 step-04 单独处理；详见 §5.2）
- `bin/chovy.js`、`bin/chovy.js.map`（AGENTS.md §9 红线 — 构建产物）
- `package.json`（**未引入新依赖**；`Bun.Glob` / `node:fs/promises` / `Bun.spawn` / `node:child_process` 全在运行时内置）
- 任何 `docs/step-XX-*.md`（接口冻结点）

---

## 3. 关键设计决策

### 3.1 `fileHistory` 用模块级 state，而非 `ctx.session`

step-08 spec 写明 "必须是已经被 Read 过的文件（在 ctx.session 维护文件 read set）"。但当前 `agent.ts` 仅调 `tool.run(parsed.data)`——`ctx` 是 `undefined`（step-06 完成报告 §3.8 给的理由）。可选方案：

- **方案 A**（采用）：把 read-set 放在 `src/tools/fs/fileHistory.ts` 模块级 `Map<resolvedPath, FileHistoryEntry>`，导出 `markRead / wasRead / recordChange` 等纯函数。`ctx.session` 到位后 *这套函数签名零变化*，仅内部实现切换为 "从 `ctx.session.fileHistory` 读"。文件顶部 `TODO step-16` 明示。
- 方案 B：在 `Tool.run` 内部从 `process.env` / 临时文件读 read-set。复杂度高 + 多进程行为不一致。否决。
- 方案 C：在 step-08 内同时改 `agent.ts` 注入 `ToolContext`。会越界引入 `ToolContext` 真实化，与 step-06 §3.8 决议冲突，否决。

方案 A 唯一的代价：同一进程内多个 sub-agent 共享 read-set（step-18 sub-agent 落地前不会出现这种情况）。step-16 / 18 落地时会改成 per-session。

### 3.2 二进制文件返回 stub，**不**绕过 `safeFs`

step-08 spec 写明 "读图片/PDF：本步暂仅返回 base64 + meta"。但 `safeFs.read` 当前只支持 utf8（step-04 设计选择）。两种妥协方式：

- **方案 A**（采用）：定义 `BINARY_EXTS` 集合（图片 / PDF / 音视频 / 归档 / 可执行）。命中时只调 `safeFs.stat()` 拿 size，返回 `[binary file: <path>]\nsize: ... bytes\next: ...` stub。`structuredOutput.kind = "binary"` 给 UI 后续渲染（step-22）。`TODO step-04` 标在文件顶。
- 方案 B：在 `read.ts` 里直接 `import { readFile } from "node:fs/promises"` 取 Buffer 转 base64。会违反 AGENTS.md §9 "❌ 直接读 / 写应用文件不走 safeFs / safeFsSync"，否决。
- 方案 C：扩 `safeFs` 加 `readBytes()`。在 step-08 PR 内做会越界改 step-04 的产物，否决。建议作为 step-04 的小补丁单独提。

stub 至少让模型知道"这是个 12345 字节的 png"，比报错或返回乱码都好；后续 step-04 + step-22 联动时即可上 base64 + Ink 图像渲染。

### 3.3 `file_edit` 的盲写守卫做在 `checkPermissions` + `run` 两层

step-08 §3 "Edit 必须是已经被 Read 过的文件"。布点选择：

- `checkPermissions` 中 `if (!wasRead(args.path)) return { outcome: "deny", reason: "..." }`——让 step-12 权限引擎在 *预检阶段* 就拦下；
- `run` 中再做一次 `wasRead()` 检查并返回 `errorCode: "TOOL_DENIED"`——防止 `checkPermissions` 还没被引擎调用就执行（当前 agent loop 就是这种情况，step-12 前 `checkPermissions` 不会被执行）。

两层都查的代价是几条 `Map.get`，收益是 *step-12 前后行为不变*。冒烟脚本里 `file_edit refuses edits to files that were not read first` 一条就是验证 step-12 前的行为。

### 3.4 `file_edit` 用 `split.join`，不用全局 `RegExp`

唯一匹配的实现：

```ts
const matches = countOccurrences(before, oldString);   // 字面计数
const after = replaceAll
  ? before.split(oldString).join(newString)            // 字面替换
  : before.replace(oldString, newString);              // 字面 replace（第一处）
```

理由：
- `oldString` 是模型给的字符串，里面常含 `[ ] ( ) . *` 等正则元字符。用 `RegExp` 必须先 escape，多一道易错环节。
- `String.prototype.replaceAll(needle: string, ...)` 内部就是字面替换语义，等价于 `split.join`，运行时开销可忽略。
- `String.prototype.replace(needle: string, ...)` 在 needle 是字符串时也是字面语义，只替换第一处——刚好满足唯一匹配模式。

### 3.5 `glob` 用 4× 过采样后 mtime 排序

`Bun.Glob.scan()` 不保证返回顺序。要按 mtime 降序排序 + 200 cap：

- **方案 A**（采用）：流式扫描时收集到 `Math.min(limit * 4, 800)` 条候选 → 全部 `stat` → 排序 → 截前 200。过采样保证排序不在小窗口里被 hash 顺序污染。
- 方案 B：先 stat 全部命中再排序。仓库大时 N×stat 太贵。否决。
- 方案 C：让 `Bun.Glob` 暴露排序选项。当前 API 不支持。

`truncatedDuringScan: true` 在过采样上限触顶时传到 `structuredOutput`，UI 可显示 "200+ matches"。

### 3.6 `grep` 的双轨：rg 子进程 + JS fallback 全 mode 等价

step-08 §5 "Grep：优先 spawn rg；降级：纯 JS 行扫描（性能差但保证可用）"。设计：

- `detectRipgrep()` 在首次调用 `grep.run()` 时用 `Bun.spawnSync(["rg","--version"])` 探测一次，结果缓存到模块级 `rgAvailable`；后续直接读缓存。`_resetRipgrepProbeForTesting()` 让测试可强制重探。
- 探测失败时打一次 `logger.warn` (`"ripgrep not found on PATH ..."`)，符合 step-08 §风险 "缺失 telemetry warn"。
- 子进程用 `node:child_process.spawn`（不是 `Bun.spawn`）——理由：跨平台行为更可预测，且 `stdio: ["ignore", "pipe", "pipe"]` 在 Bun 子进程上的语义略不同。stdout/stderr 分别 attach `data` 监听。
- 退出码语义：`0` = 有匹配，`1` = 无匹配，`2` = 错误（pattern 错 / 文件不存在）。错误码分流到 `errorCode: "INTERNAL"`。
- JS fallback 三个 mode 都实现：
  - `files_with_matches`：`Bun.Glob` 拿候选 → 跳过 `node_modules` / `.git` → `safeFs.read` → `re.test()` → 100 KiB 文件 cap 防 OOM。
  - `count`：同上 + 每文件 `body.match(re).length`，输出 `path:N`。
  - `content`：按行扫描 + 可选 `-A/-B/-C` 上下文行；`multiline` 时切换到 `RegExp.exec()` 循环 + 反查行号。
- `type` 字段在 fallback 中显式 `logger.debug` 一行后忽略（rg-only），不报错。

### 3.7 `registerTool` 改泛型——这是 step-06 收尾，但放在 step-08 PR 里

每个新 fs 工具的导出形如：

```ts
export const fileReadTool: Tool<typeof argsSchema> = { ... };
```

这种**窄**类型 `Tool<ZodObject<{ path: ZodString, ... }>>` 无法赋给非泛型的 `registerTool(tool: Tool, ...)`——因为 `Tool<T>` 在 `T` 上不变（`schema: T` 与 `z.infer<T>` 同时出现）。唯一不动 `Tool` 接口本身的修法是 *让 registerTool 泛型*：

```ts
export function registerTool<T extends z.ZodType>(
  tool: Tool<T>,
  opts: RegisterOptions = {},
): void {
  ...
  entries.set(tool.name, { tool: tool as unknown as Tool, ... });
}
```

代价：注册器内部多一次单点 `as unknown as` 抹除窄泛型。收益：tool 作者写 `Tool<typeof argsSchema>` 即可获得 `run(args, ctx)` 内 `args` 的精确类型推断，且 `registerTool(...)` 编译通过。

这本属 step-06 漏洞，但本身 1 行改动，附在 step-08 PR 里一起带走。

### 3.8 `checkPermissions` 现状：read/glob/grep `allow`；write/edit `ask`/`deny`

step-12 真权限引擎落地前，工具自检 stub：

- `file_read` / `glob` / `grep`：`canUseWithoutAsk: true`、`isReadOnly: true`、`checkPermissions() => { outcome: "allow" }`。step-12 引擎将自动 fast-path 放行。
- `file_write`：`checkPermissions()` 用 `safeFs.exists()` 区分覆盖 vs 新建，分别 `ask reason: "overwrite existing file"` / `"create new file"`；绝对路径不合规直接 `deny`。
- `file_edit`：盲写守卫 + 绝对路径不合规 → `deny`；通过后 → `ask reason: "edit existing file"`。

所有 `checkPermissions` 都不依赖 `ctx.permissions / ctx.hooks` 任何字段——符合 step-06 §3.3 "占位接口不应被 step-08 误用"。

---

## 4. 验收对照（step-08 §验收标准）

| 验收项 | 实现位置 | 实测 |
|---|---|---|
| 5 个工具均能被 OpenAI provider 端到端调用 | `src/tools/index.ts:11-25` 全部注册到 `namespace: "fs"`；`listTools({ namespace: "fs" })` 返回 5 个；`describeTools(...)` 包含全部 5 个 | ⚠️ 真 provider 调用需 step-17；当前以 smoke 脚本 16 条断言代表"协议层通"（见下） |
| Edit 在缺少前置 Read 时返回明确错误 | `edit.ts` 中两层守卫：`checkPermissions` 返回 `deny`、`run` 直接返回 `errorCode: "TOOL_DENIED"` + 友好文案 | ✅ smoke `file_edit refuses edits to files that were not read first` PASS |
| Grep 缺 ripgrep 时自动降级 | `grep.ts:detectRipgrep()` + 三 mode 的 `runFallback()` 实现 | ✅ Monkey-patch `Bun.spawnSync` 把 rg 模拟为缺失后，3 mode 全部走 `js-fallback` 并返回正确结果（PASS） |
| 在 plan 模式下 Write/Edit 被权限引擎拒绝 | `file_write.checkPermissions` 返回 `ask`；`file_edit.checkPermissions` 返回 `deny`（未 read）或 `ask`（已 read） | ⚠️ step-12 引擎未落地 → 当前 *checkPermissions 未被 agent loop 调用*。step-12 接入后行为自动生效，无须改 step-08 |

### 4.1 16 条 smoke 断言（实测 `bun scripts/smoke-fs-tools.ts`）

```
PASS: file_write creates a new file
PASS: file_read emits cat -n numbered lines
PASS: file_read shows all 3 lines
PASS: file_read rejects relative paths
PASS: file_edit replaces a unique match
PASS: file_edit took effect on disk
PASS: file_edit rejects ambiguous matches without replaceAll
PASS: file_edit replaceAll replaces all occurrences
PASS: file_edit refuses edits to files that were not read first
PASS: glob finds .ts files
PASS: glob respects extension filter
PASS: grep files_with_matches finds files containing pattern
PASS: grep content emits path:line:body
PASS: grep count returns per-file totals
PASS: grep gracefully reports no matches
PASS: file_write refuses payloads > 1 MiB

All smoke checks passed.
```

### 4.2 grep JS fallback 单独验证（实测命令）

```
$ bun -e "..."   # 强制把 rgAvailable 设为 false
{"t":...,"level":"warn","msg":"ripgrep not found on PATH — `grep` tool falls back to JS line scan"}
files_with_matches backend: js-fallback content: ".../a.ts"
content backend: js-fallback content: ".../a.ts:2:export const BAR = 2;"
count backend: js-fallback content: ".../a.ts:2"
PASS: grep JS fallback works for all 3 output modes
```

警告日志只打一次（缓存命中），符合 step-08 §风险设计。

### 4.3 ATP 与注册中心衔接（实测命令）

```
$ bun -e "import('./src/tools/index.js').then(...)"
fs tools registered: file_read,file_write,file_edit,glob,grep
namespaces: file_read=fs file_write=fs file_edit=fs glob=fs grep=fs
describeTools(100) levels: echo:lean file_read:lean file_write:lean file_edit:lean glob:lean grep:lean
```

`budgetTokens: 100` 下全部 lean，与 step-06 验收一致（守底 200 仍生效）。

### 4.4 `bun run typecheck`

```
$ tsc --noEmit
(no output, EXIT=0)
```

---

## 5. 已知限制 / TODO（按 AGENTS.md §9，明示而非伪装）

1. **`ToolContext` 当前不会下发到 `tool.run`**：agent loop 仍是 `tool.run(parsed.data)` 一参调用。所有 5 个 fs 工具内部用 `process.cwd()` 作为 cwd 默认值；`fileHistory` 用模块级 state。等 step-16 QueryEngine 重构 + step-18 sub-agent runtime 时，`ctx.cwd` / `ctx.session.fileHistory` 接入，相关代码点已在文件顶 `TODO step-06/16` 中明示。
2. **二进制 / 图片 / PDF 仅返回 size + ext stub**：step-04 给 `safeFs` 加 `readBytes()` 后，`read.ts` 中 `BINARY_EXTS` 分支可改为读 Buffer + base64 + `structuredOutput.kind="image" / "pdf"`。当前 stub 至少避免返回乱码 UTF-8。
3. **沙箱（step-14）未接入**：`file_write` / `file_edit` 当前能写到任何 OS 允许的路径——只受 OS 文件权限 + `safeFs.write` 的"父目录可创建"约束保护。step-14 将在 `checkPermissions` 中加路径前缀白名单。
4. **plan 模式拒绝（step-12）未真实生效**：所有 5 个工具 `checkPermissions` stub 已就位，但 agent loop 不调用它。step-12 引擎落地后无须改本步代码即可生效。
5. **`grep` 的 `multiline` + `-A/-B/-C` 在 fallback 中未联合**：多行模式下上下文行语义不清晰（一个匹配跨 3 行，"before 2 lines" 到底从匹配首行还是末行算？），故 fallback 在 multiline 模式下 **忽略上下文行**、只输出每个匹配的首行。rg 路径无此限制——它的多行上下文语义本就由 rg 自定义。
6. **`glob` 的默认忽略列表是闭合集**：`node_modules / .git / .svn / .hg / dist / build / .next / .turbo / .cache / .chovy / coverage / .venv / __pycache__`。用户自定义忽略（`.gitignore` / `.chovyignore`）暂不支持；`noIgnore: true` 可全开。step-14 沙箱阶段考虑接 `.gitignore` 解析。
7. **`fileHistory` 路径键用 `path.resolve()`**：在 Windows 下大小写不归一（`D:\Foo` 与 `d:\foo` 是不同 key）。`src/fs/paths.ts` 的 `normalizeCwd()` 做了 Windows 归一，但本步未复用——理由是 `fileHistory` 跟踪的是模型给的精确路径，不希望"看似不同实则相同"的合并破坏盲写守卫的语义。Windows 项目里如果模型混用大小写，应触发模型自己的一致性约束（一次 `file_read` + 一次 `file_edit` 必须用同样的 path 字符串）。
8. **`file_edit` 的 `replaceAll` 没有"逐处确认"**：cc-haha 的 FileEditTool 在 replaceAll 时会显示 diff。当前 step-08 仅返回 `replaced: N`。完整 diff 渲染交给 step-22 Ink UI。
9. **没有 `file_multi_edit`**：cc-haha 有一个 `MultiEdit` 工具支持一次多处编辑。step-08 spec 未列入；如有需求按 step-XX 新增。
10. **冒烟脚本 `scripts/smoke-fs-tools.ts` 不入 `package.json` scripts**：避免污染用户 `bun run` 列表；运行方式直接 `bun scripts/smoke-fs-tools.ts`。

---

## 6. 风险登记（建议追加到 step-08 §风险）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | ripgrep 二进制依赖 | `detectRipgrep()` 首调用探测 + 缓存；缺失时 `logger.warn` 一次（不重复）+ JS fallback 全 mode 等价支持。已验证（§4.2） |
| R2 | 大仓 `glob` 性能 / 内存 | 4× 过采样上限 `limit * 4`（默认 800）+ `truncatedDuringScan` 提示；内建忽略集兜底；模型可加 `cwd` 缩小范围 |
| R3 | `grep` fallback 在 100k 文件仓库下慢 | 候选收集硬上限 50_000 + 单文件 100 KiB 跳过 + `glob` 过滤优先；用户场景下 rg 才是常态，fallback 是降级保险 |
| R4 | `file_edit` 与 `file_write` 在多 sub-agent 并发下竞争同文件 | `safeFs.write` 是 tmp 文件 + rename 原子；但"读取 → 修改 → 写回"序列不是原子；step-18 sub-agent runtime 上线后由 SwarmR judge 层保证不并发改同文件，本工具层不做锁 |
| R5 | Windows 路径大小写差异破坏 read-set | §5.7 说明：故意保留差异；模型自己保持一致性。如成实际问题，在 step-16 ctx.session 化时统一加大小写归一 |
| R6 | 二进制文件 stub 让模型误以为是空文件 | stub 文案明示 `[binary file: ...]\nsize: ... bytes\next: ...`；`structuredOutput.kind = "binary"` 标识 UI 后续区分 |

---

## 7. 与下游步骤的衔接点

| 下游 step | 衔接位置 | 怎么改 |
|---|---|---|
| **step-04 补丁**（safeFs.readBytes） | `src/fs/safeFs.ts` 加 `readBytes(p): Promise<Uint8Array>` | `read.ts:BINARY_EXTS` 分支改为读 Buffer → base64 → `structuredOutput: { kind: "image" \| "pdf" \| "binary", bytes, base64 }` |
| **step-12**（permission engine） | `Tool.checkPermissions` 自动成为 layer 1 | 本步 5 个工具的 `checkPermissions` 无须改；引擎合入 mode（plan → 所有 `isReadOnly: false` 的 ask/deny 转 deny）、rules、hooks 后即生效 |
| **step-14**（sandbox） | 在 `checkPermissions` 中追加路径前缀校验，**或**在 engine 的 layer 4 实现 | 推荐后者，避免每个 fs 工具重复实现 |
| **step-16**（query engine） | `agent.ts → engine/queryEngine.ts` | 构造 `ToolContext` 并在 `tool.run(args, ctx)` 中真传；`fileHistory` 实现从模块级切到 `ctx.session.fileHistory`（导出 API 不变） |
| **step-17**（providers real） | Provider 端用 `describeTools({...}).map(d => providerSchema(d))` 注入工具描述 | 本步工具的 `desc.lean / full` 已就位；schema 通过 `Zod.toJSON()` 暴露 |
| **step-22**（agent UI） | `Tool.renderResult` + `ToolResult.structuredOutput` 各 `kind` 分支 | 本步在 `structuredOutput.kind` 已留好枚举：`text` / `binary` / `overwrite` / `create` / `edit` / `glob` / `grep`；UI 按 kind 渲染 cat -n / mtime 列表 / hit 列表 / diff |
| **step-26**（checkpoint writer） | `fileHistory.getHistory()` 拿到本会话改过的文件清单 | 直接消费；零改 |
| **step-27**（context monitor） | `ToolResult.meta.bytes / durMs` 累计 | 直接消费；零改 |

---

## 8. 自检清单

- [x] `bun run typecheck`：EXIT=0
- [x] 5 个 fs 工具全部注册到 `namespace: "fs"`，`listTools({ namespace: "fs" })` 返回 5 个
- [x] `describeTools({ budgetTokens: 100, ... })` 中 6 个工具（含 echo）全部 `level: "lean"`，与 step-06 守底一致
- [x] `file_read` 拒绝相对路径、emit cat -n 6-char 行号 + tab、CRLF 归一为 LF
- [x] `file_write` 拒绝 > 1 MiB、返回 `meta.filesChanged`、新建/覆盖文案区分
- [x] `file_edit` 唯一匹配、`replaceAll: true` 全替、含糊匹配明确报错、盲写守卫 deny
- [x] `glob` mtime 降序、内建忽略生效、200 cap + `truncated` 提示
- [x] `grep` rg 优先 + JS fallback 3 mode 等价、`output_mode` 三选、`multiline` 支持、`type` 在 fallback 中忽略 + debug 日志
- [x] `grep` rg 缺失时 `logger.warn` 一次（缓存命中）
- [x] 不修改 `bin/chovy.js`、`bin/chovy.js.map`
- [x] 不引入新依赖（`package.json` 未变）
- [x] 不绕过 `safeFs`：所有读 / 写都走 `safeFs.read / write / stat / exists`
- [x] 不在 `Tool` 接口（B1 冻结点）上加字段
- [x] 顶部注释明示所有 `TODO step-XX` 衔接点（step-04 / 06 / 12 / 14 / 16 / 22）
- [x] 16 条 smoke 断言全部 PASS

---

## 9. 致谢与边界

- 灵感来源：`cc-haha` 的 `FileReadTool` / `FileEditTool` / `FileWriteTool` / `GlobTool` / `GrepTool` 设计骨架（参数命名、`cat -n` 输出格式、唯一匹配语义、ripgrep 优先策略）；不复刻其图像 / Jupyter Notebook / file-history-tracker 全套（chovy-code 走 step-04 + step-22 + step-26 分层路径）
- 本步严格按 AGENTS.md §5 的 8 条硬规则执行；未越界修改 `~/.gitconfig` / `.git` / 构建产物 / dotfiles
- 本步严格按 `docs/innovations.md §10` 的"不做"清单；未引入 Docker 沙箱（沙箱设计交给 step-14 走 path-prefix-allowlist）
- 未做 `git commit / push`（按规则等用户授权）

### 9.1 与"只做 step-08，不动 step-06"用户授权的偏差汇报

启动时 `bun run typecheck` baseline 已坏（3 处错误，全部来自 step-06 半成品工作树）。在 §3.7 的小注释里说明：本步附带做了两处"step-06 收尾"修复——

1. `src/types/messages.ts` 旧 `ToolResult` 重命名为 `ToolCallResult`（linter 自动）；
2. `src/tools/registry.ts` `registerTool` 改泛型 + 单点 `as unknown as Tool`。

两处都是 1–5 行改动，未触动 step-06 类型语义或新增 step-06 类型。如不做这两处，baseline typecheck 无法通过 → step-08 无法验证。在会话中已两次开口确认。

> **下一步建议**：开 step-09（Bash tool）或 step-10（web tools），它们与 step-08 同为 B 阶段并行项，依赖完全相同（仅 step-06）。step-11（meta tools）建议放在 step-18 sub-agent runtime 之后再启，因为其中的 `agent` 元工具强依赖 `ctx.spawnSubAgent` 真实化。
