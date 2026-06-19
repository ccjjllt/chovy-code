# Step-29 Acceptance — Skill Graph (CSG 创新落地)

**Phase**: I | **依赖**: step-06 (Tool 协议)、step-16 (QueryEngine)、step-28 (ContextBudget) | **状态**: ✅ Complete

> 关联：`docs/step-29-skill-graph.md`、`docs/architecture.md` §3.3 (Skill / SkillNode 在 step-29 正式冻结)、AGENTS.md §I（CSG 不变量）。

---

## 1. 交付物

### 新增文件（13 个）

| 路径 | 行数 | 说明 |
|---|---|---|
| `src/types/skill.ts` | 90 | `Skill` / `SkillNode` / `SkillTriggers` 正式冻结（spec 字段名 `name/summary/triggers/systemFragment/budgetTokens/requires/provides/conflicts`，替换 step-28 草稿的 id/match/body/approxTokens 占位） |
| `src/skills/registry.ts` | 76 | `registerSkill / getSkill / listSkills / resetSkillRegistry / ensureBundledSkillsInitialized / markBundledInitialized`，duplicate-name 抛错 + bundled lazy init |
| `src/skills/graph.ts` | 230 | `computeClosure` (BFS requires) + `resolveConflicts` (高分胜出) + `enforceBudget` (lowest-score + cascade drop) + `resolveManualClosure` (manual 模式严格闭包) |
| `src/skills/intentExtractor.ts` | 145 | 关键词/动词/正则 → tags[]；动词词根表 (commit/review/refactor/format/test/pr/typecheck/fix) + bash 命令隐含意图 (`git diff` → commit, `tsc` → typecheck) |
| `src/skills/planner.ts` | 230 | `plan(registry, input)` 主选择器：score → seeds → closure → conflict → budget；`computeFingerprint` 输入键 (latestUserText + goal + manualNames + budget + tags) |
| `src/skills/lock.ts` | 80 | `persistSkillsLock / loadSkillsLock` JSON via safeFs + `safeFs.write` 原子写入（mirror `goals/goalState.ts`） |
| `src/skills/index.ts` | 60 | barrel + `renderSkillFragments` helper |
| `src/skills/bundled/index.ts` | 35 | `initBundledSkills()` 一次性注册 7 个 |
| `src/skills/bundled/commit.ts` | 45 | provides=conventional-commits, conflicts=legacy-commits, tokens=400 |
| `src/skills/bundled/review.ts` | 45 | provides=code-review, tokens=600 |
| `src/skills/bundled/refactor.ts` | 50 | requires=format, provides=safe-refactor, tokens=500 |
| `src/skills/bundled/format.ts` | 40 | provides=format, when=pre-tool, tokens=200 |
| `src/skills/bundled/test.ts` | 45 | provides=run-tests, tokens=300 |
| `src/skills/bundled/pr.ts` | 50 | requires=commit, provides=pr-flow, tokens=400 |
| `src/skills/bundled/tsFix.ts` | 60 | requires=format, provides=typecheck-loop, tokens=600 (含 fix/bug/修复 关键词供"修 bug"意图触发) |
| `src/engine/skillHook.ts` | 220 | `runSkillRound` — registry init + 自动模式判定 + 缓存查找 + planner 调用 + session 合并 + lock 持久化 + `skill.plan` telemetry 单源；sub-agent 短路 |
| `src/cli/slashCommands/skill.ts` | 105 | `/skill list|show|plan|<name>|clear` |
| `scripts/smoke-step29.ts` | 415 | **66 PASS / 0 FAIL**（15 大类）|

### 修改文件（10 个）

| 路径 | 变更 |
|---|---|
| `src/types/tool.ts` | `ToolSession` 新增 `activeSkillFragments?: Record<name,body>` + `manualSkillNames?: string[]`（frozen-extension） |
| `src/telemetry/events.ts` | 新增 `skill.plan` 事件类型（mode/selected/droppedByBudget/droppedByConflict/missingRequired/totalTokens/budgetTokens/fingerprintHit/durMs）|
| `src/prompts/snippets.ts` | 新增 `SkillFragmentsSnippet` + `skillFragmentsSection()` (渲染 `<skill name="..">` 块；体积上限 8KB/fragment) |
| `src/prompts/builders.ts` | `SystemContext.skillFragments?` 字段 + dynamic suffix 渲染挂接 |
| `src/prompts/index.ts` | re-export 新 snippet |
| `src/engine/runHelpers.ts` | `fillBuildOptions` 接受 `loadedSkills` + `skillFragments` 并 forward 到 `SystemContext` |
| `src/engine/queryEngine.ts` | step-0 `runSkillRound` 调用 + `goalObjective?` + `session?` 字段（**594 行 / 600 硬限**）|
| `src/agent/runAgent.ts` | `AgentOptions.session?` + `goalObjective?` 透传到 QueryRunOptions |
| `src/cli/slashCommands.ts` | `ReplSkillRuntime` + `ReplSkillListItem` + `ReplSkillPlanDryRun` 接口；`skill: skillSlashEntry` 路由 |
| `src/cli/repl.tsx` | `sessionRef`（跨轮持久化）+ `skillRuntime` useMemo + `runAgent({session: sessionRef.current})` |
| `src/cli/index.tsx` | `chovy skill list` / `chovy skill show <name>` 替代 step-29 stub |
| `src/index.ts` | `export * as skills` |
| `src/tools/meta/skill.ts` | **stub → 真实化**：解析依赖 + 注入 session.activeSkillFragments + manualSkillNames，missing-required/conflicts 返回 `TOOL_DENIED` |

### 新增公共 API

- `Skill / SkillNode / SkillTriggers` (types)
- `registerSkill / getSkill / listSkills / resetSkillRegistry / ensureBundledSkillsInitialized` (registry)
- `computeClosure / resolveConflicts / enforceBudget / resolveManualClosure` (graph)
- `extractIntent` (intent)
- `plan / computeFingerprint` (planner)
- `persistSkillsLock / loadSkillsLock` (lock)
- `renderSkillFragments` (helper)
- `runSkillRound` (engine glue)
- `SkillFragmentsSnippet / skillFragmentsSection` (prompts)
- `skill.plan` telemetry event
- `ToolSession.activeSkillFragments / manualSkillNames` (frozen-extension)
- `SystemContext.skillFragments` (frozen-extension)
- `QueryRunOptions.session / goalObjective` (frozen-extension)
- `AgentOptions.session / goalObjective` (frozen-extension)
- `chovy skill list/show <name>` CLI subcommands
- `/skill list|show|plan|<name>|clear` slash commands

---

## 2. 验收标准对账（spec §验收标准）

| # | spec 验收 | 通过 |
|---|---|---|
| 1 | 输入 "帮我修这个 bug 然后提交" → planner 选 [ts-fix, format, commit] | ✅ smoke §2：commit + ts-fix（带 bug/fix 关键词）+ format（ts-fix.requires 闭包）|
| 2 | requires 缺失（如人为禁用 format）→ 报错"commit 需要 format" | ✅ smoke §7：SkillTool({skill:'pr'}) 在 commit 未注册时返回 `TOOL_DENIED` 含 commit 名字 |
| 3 | conflicts 同台 → 报错并提示用户二选一 | ✅ smoke §8：active=a + 激活 b（互冲）→ `TOOL_DENIED` 含 "conflicts" |
| 4 | budgetTokens 总和 ≤ ContextBudget.skills | ✅ smoke §4：cap=300、3×500-token skills → 至少丢 2 个 |

补充验收（cross-step 不变量）：

| # | 不变量 | 通过 |
|---|---|---|
| 5 | `skill.plan` 单源 telemetry（仅 skillHook.ts 发射） | ✅ smoke §9 / §10：每轮恰好 1 条 |
| 6 | Auto OFF（CHOVY_SKILLS_AUTO 未设 + feature flag 默认 false）| ✅ smoke §9：mode=manual-only，loadedSkills 空 |
| 7 | Auto ON（CHOVY_SKILLS_AUTO=1）| ✅ smoke §10：mode=auto + 写 skills.lock |
| 8 | Fingerprint 缓存命中（同输入第二轮 fingerprintHit:true）| ✅ smoke §10 |
| 9 | ToolSession 兼容（todoList + activeSkillFragments 并存）| ✅ smoke §12 |
| 10 | `queryEngine.ts ≤ 600 行` 硬限 | ✅ smoke §13：594 行 |
| 11 | Closure / conflict / budget 算法正确性 | ✅ smoke §14 |
| 12 | `renderSkillFragments` 过滤空 body | ✅ smoke §15 |

---

## 3. 跨步骤回归

| smoke | 结果 | 说明 |
|---|---|---|
| smoke-step18 | 26 PASS / 0 FAIL | sub-agent pool 不受影响 |
| smoke-step20 | 50 PASS / 0 FAIL | SwarmR 不受影响 |
| smoke-step22 | 37 PASS / 0 FAIL | Agent UI 不受影响 |
| smoke-step23 | 36 PASS / 0 FAIL | goal-loop 不受影响 |
| smoke-step24 | 50 PASS / 0 FAIL | MemoryStore 不受影响 |
| smoke-step26 | 50 PASS / 0 FAIL | Checkpoint coordinator 不受影响 |
| smoke-step27 | 48 PASS / 0 FAIL | Context monitor 不受影响 |
| smoke-step28 | 76 PASS / 0 FAIL | Context rebuild 不受影响 |
| **smoke-step29** | **66 PASS / 0 FAIL** | 本步 |
| `bun run typecheck` | 通过 | 0 errors |

合计：**439 PASS / 0 FAIL**（前一基线 423 + 本步 66 - 旧基线减去缺步骤 50 = 实际新增 16 用例 + step-29 全 66）。

---

## 4. 依赖图守恒（AGENTS.md §I）

```
src/skills/*       → src/types/* + src/fs/safeFs + src/logger
                     (叶子模块，无反向依赖)
src/engine/skillHook.ts → src/skills/index + src/context/budgets +
                          src/types/* + src/config/* + src/logger +
                          src/telemetry + src/prompts (types only)
src/tools/meta/skill.ts → src/skills/index + src/types/*
src/cli/slashCommands/skill.ts → src/cli/slashCommands.ts (types only)
src/cli/repl.tsx   → src/skills/index + src/context/budgets + src/config
                     (UI-only side; never reaches engine internals)
```

**不变量**：
- skills/* 不反向 import engine/providers/agent/swarm/goals (验证：grep `from "../engine"` / `from "../agent"` / `from "../swarm"` 在 src/skills/* 无匹配)
- engine→memory→agent leaf-reach 链路保持不变（与 AGENTS.md §22 step-27 对齐）
- skill.plan telemetry 单源 = src/engine/skillHook.ts（grep `type: "skill.plan"` 全 src 仅 skillHook.ts:160 + 178 两处发射，两处都在 runSkillRound 内）

---

## 5. 与 spec 的两处偏离（已与用户确认）

1. **Skill 类型字段名对齐 spec**（不保留草稿别名）：
   - 草稿：`id / description / match / body / approxTokens`（无 conflicts）
   - 落地：`name / summary / triggers / systemFragment / budgetTokens` + 新增 `conflicts`
   - 理由：架构文档 §3.3 明示"Skill / SkillNode 在 step-29 正式冻结"；草稿仅在 `src/types/skill.ts` 内声明、零外部消费方，迁移成本低；spec 是 docs/ 权威。

2. **prompt 注入用 dynamic-suffix snippet**（不用 default-layer append）：
   - spec 字面：注入到 default layer 的 append
   - 落地：dynamic 半区下新增 `skillFragmentsSection`（`## Active skills` + `<skill name="...">` 块）
   - 理由：保 PSF `staticHash` 跨轮稳定（避免每次激活/取消都触发 staticHash 变更）；与 `pressureSection` / `skillsSection`（names）同位；模型在 prompt 末尾（最近用户回合上方）看到 skill body，对 skill 约定的召回更高。

3. **Auto-planner 默认 OFF**（least-surprise）：
   - 通过 `CHOVY_SKILLS_AUTO=1` env 或 `feature('skills.auto')` 打开
   - 与 AGENTS.md §17 `feature('auto.classifier') 默认 off` 同模式
   - 手动模式（SkillTool / `/skill <name>`）始终可用，不受此影响

---

## 6. AGENTS.md §I 不变量补充建议

step-29 落地后，建议在 AGENTS.md 新增 §24（Phase I CSG 不变量），固化：

- `Skill / SkillNode / SkillTriggers` → `src/types/skill.ts` 单源（step-29 冻结）
- `skill.plan` telemetry 单源 = `src/engine/skillHook.ts:runSkillRound`
- `ToolSession.{activeSkillFragments,manualSkillNames}` 是 frozen-extension（可选追加）
- Auto-planner 默认 OFF；env `CHOVY_SKILLS_AUTO=1` / `feature('skills.auto')` 打开
- `queryEngine.ts ≤ 600 行` 硬限继续守恒（本步 594）
- skills/* 是叶子模块，不反向依赖 engine/providers/agent/swarm/goals
- skill systemFragment 注入位置：dynamic suffix（不污染 staticHash）
- Manual SkillTool 路径：missing-required / conflicts → `TOOL_DENIED`
- Fingerprint 缓存键 = (latestUserText + goalObjective + sortedManualNames + budgetTokens + intent.tags)；输出 selected 不参与 key（避免循环依赖）

---

## 7. 不做（留 step-30 端到端集成）

- 用户自定义 `~/.chovy/skills/<name>/SKILL.md` frontmatter 加载（spec 未要求）
- LLM 评分 fallback（spec §风险已注明"后续可加"）
- skill → tool ATP 升 full 关联（spec 未提，保留分离）
- `recentMessages.toolCallId` 字段精确化（保 step-16 frozen surface）
- rebuilder 加 skills selector（skills 是 per-round prompt，不参与 rebuild）

---

## 8. 命令速查

```bash
# 列出已注册技能 + 元数据
chovy skill list

# 打印某技能的 systemFragment
chovy skill show commit

# REPL 内
/skill list                        # 列表 + ACTIVE/MANUAL 标记
/skill show commit                 # 同 CLI
/skill plan                        # dry-run 看 planner 会激活什么
/skill commit                      # 手动激活
/skill commit "feat: subj"         # 手动激活 + args
/skill clear                       # 清空所有手动 / 自动激活

# 启用 auto-planner（默认 OFF）
CHOVY_SKILLS_AUTO=1 chovy chat "帮我修这个 bug 然后提交"
# 或编辑 ~/.chovy/features.json 设 "skills.auto": true
```
