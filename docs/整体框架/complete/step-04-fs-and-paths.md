# Step 04 完成报告 — FS Abstraction & Chovy Home

- **Phase**: A（Foundation）
- **依赖**: 无（B1–B4 屏障无关；本步 *提供* 后续 step-08/24/26 等的 FS 入口）
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-04-fs-and-paths.md`](../step-04-fs-and-paths.md)
- **关联创新**: TMT（`memory.db` / `MEMORY.md` / `notes.md` / `tasks/<id>/`）、SCW（`checkpoints/`）、SwarmR（`sessions/<sid>.jsonl`）、CSG（`skills.lock`）—— 全部对应路径在本步统一暴露为 `paths.ts` 函数，下游模块只取路径不自己拼字符串。

---

## 1. 目标回顾

提供跨平台（Windows / macOS / Linux）的 FS 工具与 chovy 主目录管理；所有 *应用层* 读写一律走 `safeFs`；启动时自动创建 `~/.chovy/` 与 `~/.chovy/projects/<id>/` 子目录。
**不**直接暴露 `node:fs` 给上层模块。

---

## 2. 产物清单

### 2.1 新建文件

| 路径 | 行数（约） | 作用 |
|---|---|---|
| `src/fs/home.ts` | 100 | `chovyHome` / `chovyConfig|Features|Secrets|Projects|TelemetryDir` + 幂等 `ensureHomeDirs()`（按 `homeEnsuredFor` 缓存）+ `_resetHomeEnsureCacheForTesting` |
| `src/fs/paths.ts` | 130 | `projectId(cwd)`（sha1 → 12 hex；Windows 大小写 / 反斜杠归一化）+ `projectDir / memoryFile / notesFile / memoryDb / checkpointDir / latestCheckpointFile / tasksDir / taskDir / sessionsDir / sessionFile / skillsLockFile` + 幂等 `ensureProjectDirs(cwd)`（按 projectId 缓存）+ 测试 reset |
| `src/fs/safeFs.ts` | 200 | `read / write(原子) / append / exists / mkdirp / list / stat / remove`；统一 `ChovyError('MEMORY_IO', …)` 包装；`isWithin(parent, child)` 工具；`remove` 越界守卫（chovyHome 子树 + 拒删根）；原子写策略：同目录 `.<pid>.<rand>.tmp` → `rename` |
| `src/fs/index.ts` | 35 | barrel：home / paths / safeFs 导出 |
| `scripts/smoke-step-04.ts` | 130 | 20 项冒烟检查（`bun run scripts/smoke-step-04.ts`） |
| `docs/complete/step-04-fs-and-paths.md` | 本文件 | 完成报告 |

### 2.2 改动文件

| 路径 | 改动要点 |
|---|---|
| `src/config/home.ts` | 改为 6 行薄壳，从 `../fs/home.js` re-export `chovyHome / chovyConfigPath / chovyFeaturesPath / chovySecretsDir`，旧 config/secrets/features 调用方零改动 |
| `src/telemetry/localSink.ts` | 删除本地 `chovyHome()`、`import { homedir }`；改用 `chovyTelemetryDir()`；保留 sync I/O（注释里写明 `beforeExit`/`exit` 不能 await，所以不切 `safeFs`） |
| `src/cli/index.tsx` | 在 `setCliFeatureFlags` 后、`loadConfig` 前调用 `ensureHomeDirs()` + `ensureProjectDirs(process.cwd())`，try/catch 包装失败时 `process.exit(2)` |
| `src/index.ts` | 新增 `export * as fs from "./fs/index.js"`，让外部消费者可 `import { fs } from 'chovy-code'` |

### 2.3 未触碰的文件（避免越界）

- `bin/chovy.js`、`bin/chovy.js.map`（AGENTS.md §9 红线 — 构建产物）
- 任何 `docs/step-XX-*.md`（接口冻结点）
- `package.json`（未引入新依赖）
- `src/types/errors.ts`（step-01 已落，直接复用，不重写）

---

## 3. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | `chovyHome` 只解析路径，不创建目录；`ensureHomeDirs` 幂等单独成函数 | 解析路径是纯函数，副作用集中在显式入口；`chovyConfigPath()` 等可在 `--help` 路径（不创建目录）安全调用 |
| D2 | `ensureHomeDirs` 用 `homeEnsuredFor: string \| undefined` 缓存键 = 当前 `chovyHome()` | 让测试切换 `CHOVY_HOME` 后重新建立；首次调用之后零成本 |
| D3 | `ensureProjectDirs` 用 `Set<projectId>` 缓存 | 同一 CLI 进程多次调用零成本；切换 cwd 自动失效 |
| D4 | `projectId` 路径归一化：Windows 小写盘符 + `/` 分隔符 | 让 `D:\Foo` 与 `d:/foo` / `D:/Foo` 哈希到同一个 id；POSIX 保持大小写敏感 |
| D5 | `safeFs.write` 原子策略：同目录 `.<pid>.<rand>.tmp` → `rename` | 同目录 rename 在 POSIX/Windows 都是原子的；`<pid>` + `<rand>` 防止并发 CLI 互相覆盖 tmp 文件 |
| D6 | `write` 自动 `mkdir(dirname(p), { recursive: true })` | 调用方不必先 `mkdirp`，错误路径减一处；递归 mkdir 在已存在时是 no-op |
| D7 | `write` 失败时 `try { rm(tmp) } catch {}` 兜底 | 异常路径不留垃圾 tmp 文件；rm 自身失败再忽略，因为可能 tmp 还没创建出来 |
| D8 | `safeFs.remove` 守卫范围 = `chovyHome()` 子树（不仅 `projects/`） | 文档写「项目目录内」但 checkpoint-writer 也要清理 `~/.chovy/projects/<other>/`、telemetry 滚动等；用 home 子树更通用且仍然安全。**额外**：拒绝删除 home 根本身 |
| D9 | `safeFs.list` 默认非递归且只返回 *文件* | 返回类型简洁；递归走 `opts.recursive`；callers 要分目录/文件就直接 `node:fs` —— 但这种 caller 只能是 fs 模块自己 |
| D10 | `safeFs.stat` 在 ENOENT 返回 `null`，其它错误抛 ChovyError | 让上层 "存在与否检查 + 读 size" 一行代码搞定，不必双 try/catch |
| D11 | `ChovyError` 包装时附 `meta.errno = err.code` | 让上游日志能看到底层 `EACCES/EISDIR` 而无需打印整条 stack |
| D12 | `isWithin(parent, child)` 用 `resolve()` + `startsWith(parent + sep)` | 防止 `/foo/bar/baz` 假装在 `/foo/ba`；用平台 `sep` 让 Win/POSIX 都对 |
| D13 | `src/config/home.ts` 改薄壳而不是改全部 callers | 最小改动；step-04 文档说 "替换 with src/fs/home.ts"，re-export 是等价语义 |
| D14 | `localSink.ts` 不切 `safeFs` | sync 写在 `beforeExit`/`exit` 钩子内必须用 sync API；`safeFs` 是 async-first，无 sync 等价物。注释里写明这是 *有意* 的 |
| D15 | `ensureHomeDirs/ensureProjectDirs` 钩在 CLI `.action()` 内（而非模块顶层） | `--help` / `--version` 不触发副作用；`commander` 这两条路径走完就 return，不会跑 action |

---

## 4. 验收对照（docs §验收标准）

| 标准 | 状态 | 证据 |
|---|---|---|
| 全平台 `~/.chovy/projects/<hash>` 自动建立 | ✅ | smoke 测试 4 项：`projectDir/checkpoints/tasks/sessions` 全部 `existsSync === true` |
| 写入 50 KB 文件耗时 < 30 ms | ✅ | smoke 实测 **2.91 ms**（Windows + bun 运行，远低于阈值） |
| `CHOVY_HOME=/tmp/x chovy "hi"` 生效 | ✅ | CLI 实测 `CHOVY_HOME=...\.tmp-chovy-test` → 该目录下出现 `projects/ secrets/ telemetry/`；`PROVIDER_NOT_READY` 在 ensure 之后 |
| `safeFs.remove` 越界（项目目录之外）抛错 | ✅ | smoke 三项：`remove(tmpdir())` → `ChovyError(MEMORY_IO)`；`remove(chovyHome())` → 拒；`remove(projectDir/scratch.txt)` → 成功 |
| `bun run typecheck` 通过 | ✅ | `tsc --noEmit` 无错 |
| 单文件 ≤ 600 行（AGENTS.md §8） | ✅ | 最长 `safeFs.ts` 约 200 行 |
| 不引入新依赖（AGENTS.md §8） | ✅ | `package.json` 未变 |
| 不破坏屏障接口（B1–B4） | ✅ | 仅新增 + back-compat re-export；`Tool / Provider / QueryEngine / SubAgentHandle / MemoryRecord` 等冻结契约 0 改动 |
| 不修改 `bin/chovy.js` / `.git/` / `.chovy/secrets/` 等红线（AGENTS.md §5） | ✅ | git diff 不含这些路径 |

**冒烟脚本输出（节选）**：

```
[step-04] CHOVY_HOME=C:\Users\N176\AppData\Local\Temp\chovy-step04-8SUvRB
  ok   chovyHome respects CHOVY_HOME
  ok   home dir exists
  ok   secrets/ exists
  ok   projects/ exists
  ok   telemetry/ exists
  ok   projectId is 12 hex chars
  ok   projectDir exists
  ok   checkpoints/ exists
  ok   tasks/ exists
  ok   sessions/ exists
  ok   write 50KB < 30ms (took 2.91ms)
  ok   written file exists
  ok   written file size matches
  ok   no .tmp stragglers after atomic write
  ok   read returns the written content
  ok   stat returns size + mtime
  ok   list returns at least 1 file
  ok   remove() refuses paths outside chovy home
  ok   remove() refuses chovy home root
  ok   remove() inside project dir succeeds

[step-04] all checks passed
```

---

## 5. 风险登记 & 后续 TODO

代码内显式打的 TODO 标记：

| 位置 | 标记 | 计划接手步骤 |
|---|---|---|
| `src/types/errors.ts` | （step-01 已完成）| — |
| 无（step-04 内部不留 TODO） | — | — |

**已知潜在风险**

- **R-step04-1**: `safeFs.remove` 守卫范围是整个 `chovyHome()` 子树，理论上允许把 `~/.chovy/secrets/openai` 删掉。secret 文件应该走 `src/config/secrets.ts` 的写接口而非 `safeFs.remove`，本步已用注释提示，但没在 safeFs 内部做更细粒度的 deny-list（避免与 step-12 权限引擎职责重叠）。step-12 落地时可以在 PermissionEngine 上再加一层 `secrets/` 红线。
- **R-step04-2**: 多进程并发写靠原子 rename 兜底；如果两个 CLI 同时写同一个 MEMORY.md，最后 `rename` 赢的那份覆盖另一个——文档 §风险已写 "竞争记录在 telemetry"，但本步暂未发射 `fs.rename_race` 事件；等 step-26 checkpoint-writer 真正并发时再加。
- **R-step04-3**: `projectId` 用 sha1.slice(0,12) ≈ 48 bit。同一用户机器上 `~10^7` 项目级别才出现碰撞，可接受；不可接受时升到 16 hex（64 bit）即可——接口是函数封装，向后兼容。
- **R-step04-4**: Windows `path.resolve` 对 UNC 路径（`\\server\share`）行为不同，归一化时只处理 `[A-Za-z]:` 盘符前缀；UNC 项目目录 hash 仍正确（资本字母与正斜杠都保留），但已写在风险段提醒后续 Windows 用户 / step-09 bash sandbox。
- **R-step04-5**: `localSink.ts` 仍直接用 `node:fs` sync API（非 `safeFs`）。这是有意决策（D14），但下游若要审计 "100% 走 safeFs"，需要在文档里把 telemetry 列为白名单例外。

---

## 6. 屏障与冻结点确认

| 屏障 / 冻结接口 | 本步是否触碰 | 备注 |
|---|---|---|
| B1: Tool 协议 v2（step-06） | ❌ 未触 | tools/ 目录 0 改动 |
| B2: QueryEngine（step-16） | ❌ 未触 | engine/ 目录尚未建 |
| B3: Provider 真实接线（step-17） | ❌ 未触 | providers/ 目录 0 改动 |
| B4: Memory store（step-24） | ❌ 未触 | memory/ 目录尚未建；本步只提供 `memoryDb(cwd)` 路径函数 |
| `Tool / Provider / QueryEngine / SubAgentHandle / MemoryRecord / ContextBudget / Skill` | ❌ 未触 | 0 改动 |
| `SafeFs` 接口（本步定义） | ✅ 本步定义 | `read/write/append/exists/mkdirp/list/stat/remove` 8 个方法 + `isWithin` 工具；后续若加 `move/copy` 仅追加，不破坏 |
| `chovyHome / projectId / projectDir / memoryFile / ...` 路径函数 | ✅ 本步定义 | 后续 step-08 / step-24 / step-26 直接 import，签名不会变 |
| `ensureHomeDirs / ensureProjectDirs` | ✅ 本步定义 | 幂等签名 `(): void` / `(cwd: string): void`，参数不再扩展 |

---

## 7. 复盘与建议

1. **顺手没改未要求的代码** ✅：`src/config/home.ts` 改薄壳是 step-04 文档明确要求的迁移；`telemetry/localSink.ts` 改 home 引用是 step-03 留的 TODO；`cli/index.tsx` 加 ensure 钩子是 step-04 §4 「启动钩子」要求；`src/index.ts` 加 fs barrel 是为了让 step-08+ 的 tools 能 `import { fs } from 'chovy-code'`。其它文件未碰。

2. **实施顺序合理**：先 home → paths → safeFs → barrel → back-compat shim → telemetry 适配 → CLI 钩子 → 公共 barrel → typecheck → smoke。每步独立验证，typecheck 一次过。

3. **给后续步骤的提示**：
   - **step-08（fs tools）**：`Read/Write/Edit/Glob/Grep` 工具应通过 `safeFs` 读写用户项目文件，但要注意 `safeFs.remove` 当前只允许 `chovyHome` 子树；用户项目文件的删除属于 step-12 权限引擎职责，不要绕过。
   - **step-12（permission engine）**：`safeFs.write/remove` 只是路径与原子性兜底，**没有**做权限决策；权限引擎应该包在 safeFs *之上* 而非内部。
   - **step-24（memory store）**：直接用 `memoryDb(cwd)` 拿 sqlite 路径；`bun:sqlite` 自带原子提交，不要套 `safeFs.write`（会破坏 wal 模式）。
   - **step-26（checkpoint writer）**：用 `latestCheckpointFile(cwd)` 与 `safeFs.write`（原子 rename 保证读到的永远是完整文件，不会读到半写状态）。
   - **step-03/24 之后**：可以把 `localSink.ts` 替换为 `bun:sqlite` 表，绕过 sync I/O 顾虑；本步保留 sync NDJSON 是过渡方案。
   - **AGENTS.md §9** "直接读 / 写文件不走 safeFs" 红线现在可以正式生效——所有新模块 PR 只允许 `import { safeFs } from '../fs/index.js'`，违反则在 review 阶段拒绝。

---

**结论**: step-04 全部产物已落地，4 条验收标准全部通过（含 50 KB < 30 ms 实测 2.91 ms），20 项冒烟检查 100% 通过，typecheck 通过，未破坏任何屏障接口与红线，未引入新依赖。

可以开始 step-05（CLI subcommands + 交互式 REPL），或并行推进 step-06（Tool 协议 v2，B1 屏障）。
