# Phase A-G 复验报告

> 复验日期：2026-06-18
> 范围：Phase A（step-01–05）/ Phase B（step-06–11）/ Phase C（step-12–14）/
> Phase D（step-15–17）/ Phase E（step-18–22）/ Phase F（step-23）/
> **Phase G（step-24 + step-26，重点复验）**
> 结论：Phase A-G **全部通过复验**；本轮重点复验 Phase G，发现并修复 3 项
> （G1：step-24 ↔ step-26 的 checkpoint → MemoryStore bridge 缺 smoke 覆盖；
> G2：仓库根 `nul` 残留文件 + `.gitignore` 无 Windows 保留名守卫；
> G3：step-26 验收文档把已落地的 file-primary sync 写成"未接入"，误导后续 step）。
> Phase A-F 无回归。可继续推进 step-25（Memory Injection）/ step-27-28（SCW）。

---

## 1. 复验依据

- `docs/README.md`、`docs/architecture.md`、`docs/innovations.md`
- `docs/step-01-...md` ~ `docs/step-26-...md`（含 step-25/27/28/29/30 spec，用于界定"已实现 vs 留给后续"）
- `docs/complete/` 下 step-01～26 完成报告 + `phase-a-{c,d,e}-acceptance.md`
- `AGENTS.md`（§5 红线 / §8 风格 / §15-§21 不变量）
- `源码解析.md`（cc-haha 第六章 memdir / autoCompact / AgentTool）—— 仅吸收
  "文件是主源、store 是派生索引"与"checkpoint 是 SCW 重建的输入而非副产品"两条
  设计取向；**未**复刻 cc-haha 的 TEAMMEM 团队记忆 / KAIROS / SDK 回放协议
  （AGENTS.md §5 红线 7 + §10）。

## 2. 本轮发现并修复的问题（重点 Phase G）

| ID | 问题 | 影响 | 修复 |
|---|---|---|---|
| **G1** | step-24（MemoryStore）与 step-26（CheckpointCoordinator）各自的 smoke 全绿，但两者之间的 **bridge 从未被 smoke 覆盖**：coordinator 写出的 `checkpoints/latest.md` 是否真的能经 `syncFromFiles` 落入 store 并被 FTS5 search 命中、`layer` 是否正确标注为 `checkpoint`——没有任何断言。这是 Phase G 两半的真正价值交汇点（TMT 让 agent 能回忆起上一次 checkpoint 记了什么），缺测意味着两步"各自 green 但集成未验" | 回归风险：未来改 `syncFromFiles.collectSourceFiles` 或 `parser` 的 checkpoint 分支时，可能静默破坏 checkpoint 回忆能力而无人发现 | `scripts/smoke-step26.ts` 新增 §13 "step-24 ↔ step-26 integration"（7 项断言）：fresh project cwd → coordinator fallback 写 latest.md → `syncProject` → 断言 `filesReindexed≥1` / `records>0` / search('sqlite') 命中且 `layer==='checkpoint'` / search('conventional') 命中 / objective prose 可检索。smoke 43→50 passed。纯离线（stub pool 强制 fallback，路径确定） |
| **G2** | 仓库根存在一个 0 字节 `nul` 文件（untracked）。`nul` 是 Windows 保留设备名——非 cmd shell（git-bash / wsl / 某些重定向）把 `> nul` 当字面文件名创建。它无法用 `rm` 删除（`nul` 解析为 null device），且 `.gitignore` 未守卫此类保留名，未来极易被误 `git add` | 仓库脏；CI / 其他平台 clone 后可能产生同名冲突；`.gitignore` 无防御 | 用 `\\?\` verbatim-path 前缀（node `fs.unlinkSync`）删除残留 `nul`；`.gitignore` 追加 `nul` / `con` / `prn` / `aux` 守卫段 + 注释说明成因 |
| **G3** | `docs/complete/step-26-acceptance.md` §0 把 `memoryStore.upsertFromCheckpointFile` 列为"未接入、留给 step-27"，§6.2 说"本步不做"。但 step-24 的 `syncFromFiles.collectSourceFiles` **早已**把 `checkpoints/*.md` 当 `layer=checkpoint` 源文件解析 + upsert——即 checkpoint → MemoryRecord 的解析**已通过 file-primary sync 路径落地**，只是缺 smoke（G1）。文档表述误导后续 step（让人以为 checkpoint 根本没进 store） | 后续 step-25/27 接线者可能重复实现一遍"checkpoint 解析"，或误判 Phase G 不完整 | 修正 step-26 验收报告 §0 / §5 / §6.2：明确"已通过 file-primary sync 落地 + smoke §13 覆盖"；coordinator 内 `// TODO step-24/25` 注释改为 `NOTE`，澄清 direct-call 仅是省一次 mtime 探测的微优化、非功能缺口 |

三项修复均**最小改动**，未触碰任何冻结接口（`MemoryRecord` / `MemoryQuery` /
`MemoryStore` / `CheckpointCoordinator.maybeCheckpoint` / `CheckpointResult` /
`ToolContext.agentRole`）。无 Phase A-F 回归。

## 3. 实测命令（全绿基线）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | **PASS**（0 errors） |
| `bun run build` | **PASS** → `bin/chovy.js` 815.9 KB |
| `bun bin/chovy.js --version` | `0.1.0` |
| `bun bin/chovy.js provider list` | 7 provider 全部注册（openai/anthropic/gemini/deepseek/glm/kimi/minimax） |
| `bun bin/chovy.js agent list --builtins` | 5 内置角色注册（explorer/planner/verifier/critic/checkpoint-writer）+ ACL/omitMemory 正确 |
| `bun scripts/smoke-step-04.ts` | PASS（fs/paths，20 项） |
| `bun scripts/smoke-step07.ts` | PASS（ATP 6 case A–F） |
| `bun scripts/smoke-fs-tools.ts` | PASS（fs 工具，16 项） |
| `bun scripts/smoke-step09.ts` | PASS（bash，25 项） |
| `bun scripts/smoke-step10.ts` | PASS（web，14 项） |
| `bun scripts/smoke-step11.ts` | PASS（meta，45 项） |
| `bun scripts/smoke-step12.ts` | PASS（permission，20 项） |
| `bun scripts/smoke-step13.ts` | PASS（hooks，38 项） |
| `bun scripts/smoke-step14.ts` | PASS（sandbox，46 项） |
| `bun scripts/smoke-step15.ts` | PASS（system prompt / PSF） |
| `bun scripts/smoke-step17.ts` | PASS（providers） |
| `bun scripts/smoke-step18.ts` | PASS（sub-agent pool，26 项） |
| `bun scripts/smoke-step19.ts` | PASS（built-in agents，71 项） |
| `bun scripts/smoke-step20.ts` | PASS（swarm router，50 项） |
| `bun scripts/smoke-step21.ts` | PASS（judge，50 项） |
| `bun scripts/smoke-step22.ts` | PASS（agent UI，37 项） |
| `bun scripts/smoke-step23.ts` | PASS（goal loop，36 项） |
| `bun scripts/smoke-step24.ts` | PASS（memory store，50 项） |
| `bun scripts/smoke-step26.ts` | **PASS（checkpoint writer，50 项，含新增 §13 integration）** |
| `bun scripts/smoke-phase-b-acceptance.ts` | PASS（11 项） |

## 4. Phase G 重点复验结论

### 4.1 step-24 Memory Store（TMT 第一步）—— ✅ 无回归

- 4 类记忆 schema 冻结（`MemoryLayer` / `MemoryType` B4 屏障）；`src/types/memory.ts`
  单源，`src/memory/types.ts` 仅 re-export（grep 验证）。
- `bun:sqlite` + FTS5（unicode61）+ BM25/mixed ranker；`InMemoryStore` 降级路径
  + `memory.index { degraded:true }` telemetry。
- deterministic id（`mem_<sha1(projectId|sourcePath|sourceLine|content)[:12]>`）→
  重复 parse 走 upsert 而非重复插入。
- `rebuild('')` 抛 `MEMORY_INDEX_CORRUPT`；`db.exec(MIGRATIONS_SQL)` 整块执行（不 split，避开 FTS5 trigger `BEGIN…END;` 内嵌 `;`）。
- 性能：50KB MEMORY.md 首次索引 28ms（spec <100ms）；1k FTS 0ms（spec <5ms）。
- **本轮新验**：`syncFromFiles` 把 `checkpoints/*.md` 当 `layer=checkpoint` 源解析——smoke-step26 §13 验证该 bridge（见 G1）。

### 4.2 step-26 Checkpoint Writer（TMT 第二步）—— ✅ 修复 G1/G3 后全绿

- `CheckpointCoordinator` 30s/reason 防抖 + ≤50 归档轮转 + 规则化 fallback + 取消独立 AC（本地 AC 包装 caller signal，§9 红线）。
- 路径沙箱两层防御：`ToolContext.agentRole === "checkpoint-writer"` 时 `file_write`/`file_edit` 校验 `isWithin(checkpointDir(cwd), path)` + `assertWritable.allowOutsideCwd` 解锁 checkpoint dir 物理边界；黑名单（`.gitconfig`/`.ssh`/`.chovy/secrets`）仍 hard-deny。
- 7 段 markdown 模板 + ≤8KB 截断 + `checkpoint.written` telemetry 单源。
- `subagent_type` enum 仍不含 checkpoint-writer（由 coordinator/SCW 直接 `pool.spawn({role:"checkpoint-writer"})`，§18 一致）。
- **本轮新验（G1）**：smoke §13 证明 coordinator 写出的 `latest.md` 经 `syncProject` 落 store 后 FTS 可命中、`layer=checkpoint` 标注正确——checkpoint → MemoryStore bridge 闭合。
- **本轮修正（G3）**：验收文档 + coordinator 注释澄清"file-primary sync 已落地索引，direct-call 仅微优化"。

### 4.3 Phase G 范围内 vs 留给后续（边界澄清）

| 项 | 状态 | 归属 |
|---|---|---|
| 4 类记忆 store + FTS5 + sync + files | ✅ step-24 落地 | Phase G |
| CheckpointCoordinator + 路径沙箱 + 模板 + fallback | ✅ step-26 落地 | Phase G |
| checkpoint → store bridge（file-primary sync） | ✅ 已落地 + 本轮补 smoke | Phase G |
| 跨会话注入（`injection.ts` / `ranker.ts` / `selector.ts` / `promptSegment.ts`） | ❌ 未实现 | **step-25（Phase G，但明确留后）** |
| token-soft / big-event 触发判定 | 🟡 coordinator 入口已留，判定由 SCW 接通 | step-27/28（Phase H） |
| SessionEnd 自动触发 | 🟡 `/checkpoint now` + goal-loop 覆盖主路径 | step-30（Phase I） |

> 注：step-25（Memory Injection）按 AGENTS.md §3 列为"未实现"，是 Phase G 的
> 第三步但本轮不做（用户指定重点为已完成的 step-24/26 验收 + 解决遗留问题）。
> step-25 落地时可直接复用 `syncProject` + `store.search({text, ranker:'mixed'})`，
> bridge 已闭合。

## 5. 不变量复核

- §20（step-24）：MemoryLayer/Type/Record/Query 单源 = `src/types/memory.ts`；
  DDL 单源 = `migrations.ts` 的 `MIGRATIONS_SQL`；`memory/*` 是叶子（不反向依赖
  engine/providers/agent/swarm/goals）—— grep + 依赖图复核通过。
- §21（step-26）：`ToolContext.agentRole` frozen-extension（纯可选）；路径沙箱在
  工具层非 prompt；协调器防抖/轮转/fallback；`checkpoint.written` 单源 —— 复核通过。
- §9 红线（取消独立 AC）：coordinator 本地 AC 包装 caller signal，smoke §12 验证
  pre-aborted → fallback 不抛 —— 通过。
- queryEngine.ts ≤600 行硬限（§17）：本轮未改 engine，维持 phase-a-e P6 拆分后的 557 行。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/smoke-step26.ts` | 新增 §13 "step-24 ↔ step-26 integration"（7 项断言，43→50 passed） |
| `src/memory/checkpointWriter.ts` | `// TODO step-24/25` 注释 → `NOTE`，澄清 file-primary sync 已落地、direct-call 仅微优化 |
| `docs/complete/step-26-acceptance.md` | §0/§5/§6.2 修正：MemoryStore 接入已通过 file-primary sync 落地 + smoke §13 覆盖 |
| `.gitignore` | 追加 Windows 保留名守卫（`nul`/`con`/`prn`/`aux`）+ 成因注释 |
| `nul`（仓库根残留） | 删除（`\\?\` verbatim-path 前缀 unlink） |
| `AGENTS.md` | §3 仓库现状 + §1 当前阶段补"Phase A-G 复验通过"指针（见下） |

## 7. 下一步

- step-25（Memory Injection）：`syncProject` + `store.search` 注入 system prompt
  `[memory]` 段；MemoryWriteTool；SessionStart warmUp。bridge 已就绪。
- step-27/28（SCW）：`contextBudget` 阈值 → `coordinator.maybeCheckpoint('token-soft')`；
  重建材料 = `latest.md` + memory top-K + progress + 最近 K 消息。
- step-30（端到端）：SessionEnd 自动 checkpoint 触发。

---

**结论**：Phase A-G 全部通过复验。Phase G 重点复验修复 3 项（G1 集成 smoke /
G2 nul 残留 / G3 文档准确性），无 Phase A-F 回归，typecheck + 全 smoke + build
全绿。Phase G（step-24 + step-26）两半及其 bridge 验收闭合，可启动 step-25。
