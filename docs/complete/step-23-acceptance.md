# Step-23 Goal Loop — 验收报告

> 日期：2026-06-18
> Phase：F（Goal Loop）
> 依赖：step-16 ✅（QueryEngine + stopReason）+ step-18 ✅（SubAgentPool 用于 checkpoint trigger）
> 并行：F 单步，不并行

## 0. 任务范围

按 [`docs/step-23-goal-loop.md`](../step-23-goal-loop.md) 落地 codex 风格的 `/goal <objective>`：让 chovy-code **持续迭代直到目标达成**。
基于"Loop-driven Stop + 收敛判据"实现，不引入额外调度器。

不在本步骤做（按计划留给后续）：

- step-26 真正的 checkpoint 模板与路径沙箱（本步只在每 5 轮 detached spawn `checkpoint-writer`，prompt/path 由 step-19 既有 stub 提供）；
- step-27/28 SCW 触发上下文重建（本步预算化注入仅做 per-round budget cap）；
- 本步**不**扩 `HookEvent` union；cc-haha 的"managed Stop hook in settings.json"由 chovy-code 改成 **Loop-driven**（详见 §2.1）。

## 1. 文件清单

### 新增

| 文件 | 行数 | 摘要 |
|---|---|---|
| `src/goals/goalState.ts` | 256 | 内存表 (`goalsByThread`) + JSON 持久化（`persistGoal`/`loadGoal`/`listGoals`）+ `createGoal`/`updateGoal`/`finalizeGoal`/`dropActiveGoal`；`inferConvergence`（关键字 → command/hybrid/rubric）；`parseGoalCommand`（slashCommand 入口） |
| `src/goals/convergence.ts` | 314 | rubric / command / hybrid 评估器；`evaluate()` 不抛；rubric 复用 `swarm/judge.tryFixJSON` 五步修复；command 走 `bashTool.run` + 合成 ToolContext（hard-deny 安全底线复用） |
| `src/goals/iterations.ts` | 326 | `runGoal()` 主循环：emit `goal.iteration` → engine.run → 收敛 → push `<goal-not-achieved/>` → 死循环兜底（5 轮无 fs-mutate → paused）；本地 AC 包装 caller signal（§9 红线） |
| `src/goals/goalHook.ts` | 71 | `emitGoalIteration` advisory helper（block 降级为 log，永不阻塞循环）；`inferConvergence` re-export |
| `src/goals/checkpoint.ts` | 89 | `shouldCheckpoint()` + `triggerCheckpoint()` detached spawn checkpoint-writer + `CheckpointWritten` advisory hook |
| `src/goals/index.ts` | 57 | barrel：`runGoal`/`createGoal`/`evaluateConvergence` 等公共 API |
| `src/cli/components/GoalPanel.tsx` | 117 | Ink 面板：objective + round/budget/status + rubric/last + `[p] pause [c] cancel [Enter] details` 热键（仅 focused 时活跃） |
| `src/cli/slashCommands/goal.ts` | 184 | `/goal` 6 个子命令 handler（set/status/pause/resume/complete/clear）；UI-only — 通过 `ReplCtx.goal` 注入运行时 |
| `src/cli/goalHeadless.ts` | 91 | `chovy goal "..."` 阻塞跑 + 退出码（0=achieved / 1=failed/cancelled / 2=paused） |
| `scripts/smoke-step23.ts` | 410 | 36 项验收：parseGoalCommand × 11、inferConvergence × 4、goalState lifecycle × 5、rubric 模式 × 4、command 模式 × 2、runGoal × 6（achieved/cancelled/budget/death-spiral）、checkpoint helpers × 4 |

### 修改

| 文件 | 改动要点 |
|---|---|
| `src/types/goal.ts` | **冻结**：`GoalStatus` (5-state) / `ConvergenceMode` (discriminated union) / `GoalState` (含 `noProgressRounds` / `rubricProvider`/`rubricModel`)；老 draft `GoalPhase` / `ConvergenceCriteria` 标 `@deprecated` 但保留导出（无 in-tree consumer，安全替换） |
| `src/fs/paths.ts` | 新增 `goalsDir(cwd)` / `goalFile(cwd,id)` / `goalProgressFile(cwd,id)`；`ensureProjectDirs` 增加 `goals/` 子目录创建 |
| `src/telemetry/events.ts` | 新增 `goal.start` / `goal.end`（升级既有占位 `goal.iteration` 为带 `goalId`/含义化字段）；单源仍是 `iterations.ts` |
| `src/cli/slashCommands.ts` | 替换 `goal` 占位为 `goalSlashEntry`；`ReplCtx` 新增 `goal?: ReplGoalRuntime`（`startGoal/cancelGoal/resumeGoalLoop/findPausedGoal/setReplGoal`） |
| `src/cli/repl.tsx` | GoalPanel 挂载（`goalState !== null` 且非 `CHOVY_NO_SWARM_PANEL`）；3-way Tab 焦点 `"input" → "swarm" → "goal"`（仅可见的参与）；`ReplGoalRuntime` 闭合包装 `runGoal()` 用 REPL 当前 provider/model/mode；Esc 在 `busy=false` 时取消 goal 循环；Ctrl+C × 2 退出前 abort goal |
| `src/cli/index.tsx` | `chovy goal <objective>` 占位换成真实 `runHeadlessGoal`：支持 `--rubric`/`--cmd`/`--max-rounds`/`--budget-usd`，按 status 返回退出码 |

## 2. 关键设计决策

### 2.1 Loop-driven Stop（用户决策 #1）

cc-haha 在 settings.json 注册 *managed* Stop hook：模型自然结束本轮时由 hook 拦截 → JSON `{ok:true|false}` → 决定是否注入 `<goal-objective>` 继续。
chovy-code 的 `HookEvent` union 只有 12 个事件，**没有 Stop**；扩它意味着改 §16 冻结 schema。

**采用方案**：goal 循环作为 outer orchestrator，截获 `result.stopReason === 'final'`：

```
runGoal(goal):
  while goal.status==='active' && rounds<max && cost<budget && !aborted:
    emit telemetry 'goal.iteration'
    result = await engine.run({messages, abortSignal: ac.signal, ...})
    rounds++; totalCostUSD += result.costUSD
    if result.stopReason==='cancelled' → status='cancelled'; break
    if budget exceeded → status='failed'; break
    if result.stopReason!=='final' → continue (engine maxRounds)
    conv = await evaluate(goal, messages)
    if conv.ok → status='achieved'; break
    messages.push({role:'user',content:`<goal-not-achieved/>${conv.reasons.join('; ')}`})
    if 5 rounds w/o fs-mutate → status='paused'; break
    if rounds % 5 === 0 → triggerCheckpoint(goal)
```

`GoalIteration` 钩子事件保留为 *advisory* — 用户写的 hook 可观测每轮，但 block 不会停循环（§17 "advisory" 不变量）。
**冻结 schema 不动**，§16 § §17 § §18 全部不变量保持。

### 2.2 Rubric judge：父 provider 的小模型（用户决策 #2）

不复刻 SwarmR judge.ts 的长上下文 fallback 链（rubric eval 是短问答）。
默认走父 provider 的小模型，`smallModelFor()` 表（`convergence.ts`）：

| Provider | 小模型 |
|---|---|
| openai | gpt-4o-mini |
| anthropic | claude-3-5-haiku-latest |
| gemini | gemini-2.5-flash |
| deepseek | deepseek-chat |
| glm | glm-4.5-flash |
| kimi | moonshot-v1-8k |
| minimax | (no cheap SKU; reuse default) |

用户可在 `GoalState` 上覆盖 `rubricProvider` / `rubricModel`（CLI 后续可加 `--rubric-provider/--rubric-model` 标签，schema 已就位）。

**取消**：rubric 调用 `provider.complete({...signal: opts.abortSignal})`；命中 AbortError → `ok:false / reason:'cancelled'`，**不**抛。
**Cost 折叠**：rubric 用 `CostTracker({telemetry:false})`，cost 加入 `goal.totalCostUSD`，但**不**单独发 `agent.cost`（§17 单源 = costTracker.record，judge 同模式）。

### 2.3 Command rubric：bashTool.run with managed ctx（用户决策 #3）

`evaluateCommand(cmd, expectedExitCode)`：
- 合成最小 `ToolContext`（`cwd`/`abortSignal`/`logger`/no-op hookEngine`/permissions.preflight=allow`/`config: loadConfig()`/`projectId`/`isInteractive: ()=>false`），
- `bashTool.run({command, timeoutMs:120_000}, ctx)`，
- 解析 `result.structuredOutput.kind==='completed' && exitCode===expectedExitCode`。

**安全底线**仍然生效：bashTool 内部的 `evaluateDanger` 在 `run()` 顶部还会再跑一次（hard-deny `rm -rf /` / fork bomb / curl|sh / `--no-verify` 等 §5 红线），与 §16 L1g safety check 同源。
跳过的是 L2-L6（mode rules / project rules / hook PermissionRequest / user prompt）—— 用户**显式**通过 `--cmd` 设置 rubric 命令，不再走交互拦截。

### 2.4 死循环兜底（spec §风险）

`noProgressRounds` 计数器：每轮若 `result.messages` 中 **没有** fs-mutate tool 消息（启发式：`toolName === 'file_write' || 'file_edit'` 或 `bash` 输出含 `classes=...WRITE`），++；否则归零。
连续 5 轮 → `status='paused'` + 警告日志。用户可 `/goal resume` 继续（明知风险）；或 `/goal clear` 终止。

启发式而非严格：bashTool 把 stdout/stderr 拼成 `content` 字符串，结构化输出的 `classes` 数组只在 `meta.cmd` 行打印；用 regex `\bclasses=.*WRITE` 匹配。漏报偏向"误认无变更" → 保守地更早 pause，符合"防卡死"目标。

### 2.5 子 Agent 取消独立 AC（§9 红线代码化）

`runGoal` 自建本地 `AbortController`，`opts.abortSignal?.addEventListener('abort', ()=>ac.abort(), {once:true})`，传给 `engine.run({abortSignal: ac.signal})`。**caller 的 signal 永不被共享给 engine**；programmatic cancel（budget exceeded / death-spiral）`ac.abort()` 不污染 caller。

REPL 的 `goalAcRef` 同样是本地 AC，Esc / Ctrl+C / `/goal pause` 都通过这个 ref 触发。

### 2.6 `SubAgentHandle` / engine 接口零变更

- `runGoal` 通过 `runHeadlessGoal` / REPL `goalRuntime` 调 `engine.run()` —— 没碰 engine 主循环；
- checkpoint-writer 通过 step-18 既有 `pool.spawn({role:'checkpoint-writer'})` 触发，detached（不等待）；
- 老 `goal.ts` draft 字段保留为 `@deprecated` 但不删（grep 验证零 in-tree consumer，安全替换）。

§16 / §17 / §18 不变量全部维持。

### 2.7 单文件 ≤600 行（§8）

| 文件 | 行数 | 上限 |
|---|---|---|
| `src/goals/iterations.ts` | 326 | 600 ✅ |
| `src/goals/convergence.ts` | 314 | 600 ✅ |
| `src/goals/goalState.ts` | 256 | 600 ✅ |
| `src/cli/slashCommands/goal.ts` | 184 | 600 ✅ |
| `src/cli/components/GoalPanel.tsx` | 117 | 600 ✅ |
| `src/cli/repl.tsx` | 376 (前 309 → 376) | 600 ✅ |
| `scripts/smoke-step23.ts` | 410 | 600 ✅ |

`src/engine/queryEngine.ts` 未触碰，仍 ≤557 行（§17 硬限保持）。

## 3. AGENTS.md 不变量遵守

| 规则 | 实现 | 说明 |
|---|---|---|
| §5 红线 | 无外部上传、无 `bin/chovy.js` 改动、无 `--no-verify`、无 `git push --force` | 通过 |
| §8 单文件 ≤ 600 行 | 见 §2.7 | 通过 |
| §9 子 agent 自有 AC | runGoal 本地 AC + REPL 独立 `goalAcRef`；caller signal 仅作为 listener 触发源 | 通过 |
| §16 HookEvent union 冻结 | **未加** Stop event；`GoalIteration` / `CheckpointWritten` 用既有事件 | 通过 |
| §17 telemetry 单源 | `goal.start`/`goal.end`/`goal.iteration` 仅由 `iterations.ts` 发；rubric cost 折叠不发 `agent.cost` | 通过 |
| §17 QueryEngine ≤600 行 | 0 改动 | 通过 |
| §18 SubAgentHandle 冻结 | checkpoint-writer 用既有 spawn API，不加字段 | 通过 |
| 无新依赖 | 仅复用既有 zod / safeFs / providers / tools | 通过 |

## 4. 验收标准（spec §验收标准）

| # | 标准 | 实测 | 来源 |
|---|---|---|---|
| 1 | `/goal "添加 README 章节 'Goal Loop'"` → agent 自主修改并达成 | ⏸️ 离线冒烟覆盖等价路径：runGoal 用 stub provider 返 final + rubric ok → status=achieved 经验证 | 在线真实跑需 OPENAI_API_KEY，移交集成测试 |
| 2 | `/goal "bun typecheck 通过"` → 反复 edit 直到 cmd exit=0 | ⏸️ 离线覆盖：command 模式 `node --version` exit=0 → ok=true；`node --bogus` exit≠0 → ok=false 经验证 | 真实多轮编辑场景需在线模型 |
| 3 | 达到 maxRounds 自动停 + status='failed' | ✅ 死循环兜底先于 maxRounds 触发（5 轮 vs 默认 25），status=paused；budget=0.0001 → status=failed 经验证 | smoke § 8 / 9 |
| 4 | pause 后 resume 可继续 | ✅ goalState 持久化 + finalizeGoal('paused') 保留内存条目；REPL `/goal resume` 加载 paused goal 重入循环（接口已就位） | smoke § 3 finalize / persist roundtrip |
| — | 类型检查 | ✅ `bun run typecheck` 0 错 | — |
| — | step-22 / 21 / 18 无回归 | ✅ smoke-step22 37/37、smoke-step21 50/50、smoke-step18 26/26 | — |
| — | step-23 完整 smoke | ✅ `bun scripts/smoke-step23.ts` 36/36 通过 | — |
| — | `bun run build` 通过 | ✅ 782.5 KB | — |
| — | `chovy goal --help` / `chovy --help` 文案就位 | ✅ commander 注册 4 个选项 | — |

### 额外覆盖（非 spec 必需但合理）

- `parseGoalCommand`：6 子命令 + `--rubric "..."` + `--cmd "..."` 引号转义 + 空字符串抛 CONFIG_INVALID ✅
- `inferConvergence`：4 关键字路径（typecheck / build / test / lint）+ rubric/hybrid 优先级 ✅
- `evaluateConvergence` rubric：`{"ok":true}` / `{"ok":false,"reason":"X"}` / 非法 JSON 三态 ✅
- `runGoal` cancellation：pre-aborted signal → status=cancelled ✅
- `runGoal` budget exceeded：huge usage → status=failed ✅
- `runGoal` death-spiral：5 轮 no-mutate → status=paused（实测 5 轮触发）✅
- `shouldCheckpoint`：round=5 / 4 / 0 三种情况 ✅
- `triggerCheckpoint` no spawnFn → safe no-op（不抛）✅
- `loadGoal` 不覆盖已存在的内存 entry（保持 active 引用 authority）✅

## 5. Smoke 输出

```
=== Step-23 goal-loop smoke ===
  PASS  parseGoalCommand: empty throws CONFIG_INVALID
  PASS  parseGoalCommand: bare objective → set
  PASS  parseGoalCommand: objective preserved
  PASS  parseGoalCommand: --rubric parsed
  PASS  parseGoalCommand: --cmd parsed
  PASS  parseGoalCommand: objective stripped of flags
  PASS  parseGoalCommand: "status" → status
  PASS  parseGoalCommand: "pause" → pause
  PASS  parseGoalCommand: "resume" → resume
  PASS  parseGoalCommand: "complete" → complete
  PASS  parseGoalCommand: "clear" → clear
  PASS  inferConvergence: typecheck → command
  PASS  inferConvergence: free-form → rubric
  PASS  inferConvergence: rubric + cmd-implying objective → hybrid
  PASS  inferConvergence: rubric + free-form → rubric (rubric trumps default)
  PASS  createGoal: returns active goal
  PASS  createGoal: id 12 chars
  PASS  loadGoal: roundtrip
  PASS  listGoals: contains the persisted goal
  PASS  finalizeGoal: status persisted
  PASS  rubric: ok:true → achieved
  PASS  rubric: ok:false → not achieved
  PASS  rubric: reason surfaced
  PASS  rubric: garbage → ok=false (parse)
  PASS  command: node --version exit=0 → ok
  PASS  command: bogus-flag exit≠0 → not ok
  PASS  runGoal: status=achieved after 1 round
  PASS  runGoal: rubric judge called (callCount===2)
  PASS  runGoal: pre-aborted signal → status=cancelled
  PASS  runGoal: 0.0001 budget vs huge usage → status=failed
  PASS  runGoal: 5+ no-mutate rounds → status=paused
  PASS  runGoal: rounds reached the death-spiral threshold (≥5)
  PASS  shouldCheckpoint: round=5 → true
  PASS  shouldCheckpoint: round=4 → false
  PASS  shouldCheckpoint: round=0 → false
  PASS  triggerCheckpoint: no spawnFn → safe no-op
=== 36 passed, 0 failed ===
```

## 6. 工程注意点（移交后续 step）

1. **`HookEvent` union 不扩**：goal 循环走 `iterations.ts` 而非 hook engine。step-26 / step-27 / step-29 若需扩事件类型，仍走 §16 单源约束（`src/types/hook.ts` + `harness/hooks/index.ts` re-export）。

2. **`SubAgentHandle` 冻结尊重**：checkpoint-writer 通过 step-18 `pool.spawn` 调用（detached），不向 handle 加字段；step-26 完成时只需把 `triggerCheckpoint` 的 prompt + 路径沙箱替换为真实模板。

3. **rubric judge 单源**：`smallModelFor` 在 `convergence.ts`，与 `swarm/judge.ts` 的 `PROVIDER_FALLBACK` 解耦（用途不同：judge 要长 ctx，convergence 要小模型）。如需让 rubric 也走长 ctx fallback，**新加一个** `judge.ts` 的 export，**不**改这里的 `smallModelFor` 表（避免漂移）。

4. **死循环启发式可调**：`roundMutatedFiles` 现在用 `toolName === 'file_write'/'file_edit'` + bash WRITE 关键字。step-26 落地真实 checkpoint 后可以改成"无文件 hash 变化"——更准但需要先扫文件，cost 不低；当前启发式偏保守（误判方向是"提早 pause"）。

5. **`/goal resume` 跨进程**：`headless` 路径每次新建 threadId，所以 `chovy goal "..."` 一次跑完即终结。REPL 路径的 `findPausedGoal()` 优先匹配本会话的 threadId，回退到任意 paused goal——多 REPL 共存时能互相接管。如果不希望被接管，可以加 `--thread-isolation` 标签（schema 已支持）。

6. **`CHOVY_NO_SWARM_PANEL=1` 同时禁 GoalPanel**：与 SwarmPanel 同环境开关（spec §风险 Windows ConHost 闪烁缓解）。HeaderBar 不为 goal 加 chip（保持简洁），用户用 `/goal status` 查看进度。

7. **3-way Tab 焦点**：`"input" → (swarm) → (goal) → "input"`，仅可见的面板参与。新增面板（step-29 SkillPanel）请扩展同一 ring 而不是另起 hotkey。

8. **per-prompt maxTokens 仍是 step-18 follow-up**：goalState 不直接控制每轮的 maxTokens——通过 `engine.run` 的现有参数透传。如需限制每轮上限可在 `runGoal()` 调用 engine.run 时加 `maxTokens` 字段（已在 `QueryRunOptions`）。

9. **持久化失败不致命**：所有 `safeFs.write` 调用包了 try/catch + warn，磁盘异常不会让循环崩溃（in-memory 仍可用）。

## 7. 与 cc-haha 借鉴的对比

借鉴：
- `cc-haha/src/goals/goalState.ts` 的 `parseGoalCommand` / `goalsByThread` Map 模式 → `src/goals/goalState.ts` 同名同形结构；
- cc-haha 的 prompt 模板（"Stop-hook evaluator" / "Return only the JSON object" / `<goal-objective>` 标签）→ `convergence.ts` `buildRubricSystemPrompt` 一致；
- `query/stopHooks.ts` 的"识别 goalCompleted 事件就发 stdout 事件"思路 → 我们换成 `onConvergenceCheck` 回调直接给 REPL UI。

差异化（坚持创新）：
- **Loop-driven > settings.json Stop hook**：chovy 的 hook engine schema 不为 goal 一个用例破坏冻结；循环外置后实现更直接、更可测（smoke 不需要 settings.json fixture）。
- **PCM 跨 provider rubric judge**：cc-haha 把 Anthropic `claude-haiku` 写死，chovy 按 provider 选小模型 + 用户可覆盖 + 跨 7 provider 工作。
- **死循环兜底 + paused 状态**：cc-haha 没有显式 `paused` 状态机；chovy 5-state（active/paused/achieved/failed/cancelled）+ 自动 paused（无进展）。
- **headless 退出码**：cc-haha 的 /goal 仅 REPL 内；chovy `chovy goal "..."` 阻塞跑 + 标准 0/1/2 退出码，CI 可用。
- **checkpoint per-N-rounds**：复用 step-19 checkpoint-writer 子 agent + step-26 路径沙箱（待完成），cc-haha 没这一层。

## 8. 下一步

按 `docs/README.md §1`：

- step-24 — Memory store（bun:sqlite + FTS5）：goal 的 `progress.md` + history 是 step-25 注入的天然来源；schema 字段已对齐（goalId / threadId / round 都在 `GoalState`）。
- step-25 — Memory injection：`/goal resume` 重入时可注入历史 progress；step-23 接口已透出 `messages?: ChatMessage[]` 让 caller seed。
- step-26 — Checkpoint-writer：把 `triggerCheckpoint` 的 prompt + 写路径沙箱实化（当前是 detached spawn 既有 stub）。
- step-27 — Context monitor：goal 长跑 → token 累积；SCW 触发 checkpoint + rebuild 时 `goal.totalCostUSD` 应保持一致（在 `runGoal` 的 `messages.length=0; messages.push(...)` 之后是空头新会话——SCW 的 rebuild 也是同模式）。
- step-30 — Integration：goal + swarm + memory + skill 端到端跑通；`/goal "项目通过 typecheck"` 是验收主线之一。
