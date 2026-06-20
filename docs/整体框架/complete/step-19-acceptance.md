# Step-19 Built-in Sub-Agents — 验收报告

> 日期：2026-06-18
> Phase：E（Sub-Agent System）第二步
> 依赖：step-18 ✅
> 可并行：step-20（SwarmR）、step-22（Ink UI）

## 0. 任务范围

按 [`docs/step-19-built-in-agents.md`](../step-19-built-in-agents.md) 落地 5 个内置子 agent
角色（Explore / Plan / Verify / Critic / CheckpointWriter），冻结
`BuiltInAgentDefinition` 接口，并让 `pool.ts` 在 spawn 时自动应用每个角色的
工具白/黑名单、模型偏好、`omitMemory`、budget/timeout/maxRounds 与 Layer-2
system prompt。

不在本步骤做（按计划留给后续）：
- SwarmR `dispatch(N)` 并发分发 / Judge 聚合 → step-20 / step-21
- Ink UI 子 agent 进度面板 → step-22（本步落地的 `subagent.spawn/end` 事件 +
  handle 字段已被 step-22 复用）
- checkpoint-writer 实质内容 + 路径沙箱 → step-26
- 主 agent 通过工具显式 override provider/model → 设计选择：pool 自动应用角色
  定义，caller 只能收紧（least-privilege），工具 schema 不暴露 override 字段
- `bin/chovy.js` 构建产物不动

## 1. 文件清单

### 新增

| 文件 | 行数 | 摘要 |
|---|---|---|
| `src/agent/builtin/registry.ts` | ~52 | `AGENT_REGISTRY`（`Map<AgentRole, BuiltInAgentDefinition>`）+ `registerBuiltinAgent` / `getBuiltinAgent` / `listBuiltinAgents` / `_resetBuiltinAgentsForTesting` |
| `src/agent/builtin/exploreAgent.ts` | ~70 | role `explorer`：只读快搜；disallow `file_edit/file_write/bash/agent/...`；`omitMemory:true`；小模型；READ-ONLY prompt + 结构化输出模板 |
| `src/agent/builtin/planAgent.ts` | ~60 | role `planner`：架构师；disallow `edit/write/bash/agent`；`omitMemory:false`；严格 Plan 模板（Goal/Approach/Steps/Critical Files/Risks） |
| `src/agent/builtin/verifyAgent.ts` | ~60 | role `verifier`：独立验证；allowed `bash/file_read/grep/glob`（紧白名单）；PASS/FAIL/PARTIAL 输出格式 |
| `src/agent/builtin/criticAgent.ts` | ~70 | role `critic`（chovy 新增）：对抗式审阅；disallow `edit/write/bash/agent`；risks[]/unverified_assumptions[]/edge_cases[]/improvement_suggestions[]；禁止 "Looks good" |
| `src/agent/builtin/checkpointWriterAgent.ts` | ~50 | role `checkpoint-writer`（step-26 占位）：allowed `file_read/file_write`；`omitMemory:true`；≤8KB；prompt 标注 TODO step-26 |
| `src/agent/builtin/index.ts` | ~32 | 注册 5 角色 + re-export API（`registerBuiltinAgent` / `getBuiltinAgent` / `listBuiltinAgents` + 5 个定义） |
| `scripts/smoke-step19.ts` | ~330 | 覆盖 11 组验收：registry / explore 黑名单 / verify 白名单 / critic 对抗 prompt / cp 占位 / merge helpers / plan 模板 / pool 真跑 explorer / pool 应用 verify 白名单 / pool 应用 explorer 黑名单 / caller 收紧 |

### 修改

| 文件 | 摘要 |
|---|---|
| `src/types/agent.ts` | **冻结** `BuiltInAgentDefinition`：step-01 草案的 `systemPrompt: string` 升级为 spec 的 `getSystemPrompt(ctx: SystemContext): string`（动态）；新增 `whenToUse` / `budgetUSD` / `timeoutMs` / `maxRounds`；`description` 改可选别名；`import type { SystemContext }` 自 `prompts/builders.js`（type-only，无循环） |
| `src/agent/pool.ts` | `spawn()` 查 `getBuiltinAgent(role)` 一次，喂 timeout watchdog；`runChild()` 合并 roleDef（provider/model/budget/maxRounds + `mergeAllowlist`/`mergeDenylist`）；`buildSystemPromptOpts()` 用 `roleDef.getSystemPrompt(ctx)` + `roleDef.omitMemory`；新增 `_mergeAllowlistForTesting` / `_mergeDenylistForTesting` 导出 |
| `src/agent/index.ts` | 加 `import "./builtin/index.js"`（副作用注册 5 角色）+ re-export builtin API + merge helpers |
| `src/tools/meta/agent.ts` | `desc.full` 从将来时改现在时（step-19 已 ship）；列 4 角色 whenToUse；注释说明角色定义拥有工具/模型/prompt（caller 不可 override） |

## 2. 类型冻结摘要（架构 §3.3）

```ts
// BuiltInAgentDefinition（step-19 最终版）：
//   role: AgentRole
//   whenToUse: string                 // 暴露给主 agent
//   description?: string              // 可选别名
//   allowedTools?: string[]           // 白名单（与 disallowed 互斥）
//   disallowedTools?: string[]        // 黑名单
//   preferredProvider?: ProviderId
//   preferredModel?: string           // undefined = 继承父
//   omitMemory?: boolean
//   budgetUSD?: number                // 角色级 budget 覆盖
//   timeoutMs?: number                // 角色级 timeout 覆盖
//   maxRounds?: number                // 角色级 maxRounds 覆盖
//   getSystemPrompt(ctx: SystemContext): string  // 动态 Layer-2 prompt

// 优先级（pool.ts runChild）：caller SpawnInput > roleDef > 全局默认
// 工具合并（least-privilege）：allowedTools 交集（caller 只能收紧）；
//   disallowedTools 并集（两层都拒）；空数组 = no-op（不误杀全部工具）
```

### 与 spec 的差异（记录在案）

- **接口形态**：spec 写 `getSystemPrompt(ctx: SystemContext)`，step-01 草案写
  `systemPrompt: string`。本步**对齐 spec**（动态函数），因为角色 prompt 需要
  读 `ctx.cwd`/`ctx.model`/`ctx.planMode`（如 Verify 把测试命令写进 prompt）。
  旧 `systemPrompt` 字段无人引用，安全删除。
- **`AgentRole` 字面量**：spec 例子用 `'explore'/'plan'/'verify'/'critic'`，
  但 `AgentRole`（step-01 冻结）用名词形 `'explorer'/'planner'/'verifier'/'critic'`。
  本步沿用 `AgentRole`（单源规约，AGENTS.md §16）；spec 例子仅作说明。
- **`checkpoint-writer` 不经 `agent` 工具**：`subagent_type` zod enum 只列
  Explore/Plan/Verify/Critic。`checkpoint-writer` 由 step-26 / SCW 直接
  `pool.spawn({role:"checkpoint-writer"})`，不暴露给主 agent（spec §CheckpointWriter
  明确"详见 step-26"）。

## 3. AGENTS.md 不变量遵守情况

| 规则 | 实现位置 | 说明 |
|---|---|---|
| §5 least-privilege | `pool.ts:mergeAllowlist` 交集 + `mergeDenylist` 并集 | caller 只能收紧角色工具池，不能放宽；空数组 = no-op（防误杀） |
| §16 单源规约 | `BuiltInAgentDefinition` 单源在 `types/agent.ts`；`SystemContext` 单源在 `prompts/builders.ts`（`import type`，无重声明） | barrel 不重复导出 `SystemContext` |
| §17 5 层 prompt | `buildSystemPromptOpts` 把 `roleDef.getSystemPrompt(ctx)` 放 Layer-2（`agent`）+ snapshot envelope 前置 | 不破坏 `override` 短路 / 静态/动态分区 / PSF |
| §17 omitMemory | `buildSystemPromptOpts` 读 `roleDef.omitMemory ?? false` 喂 `AgentPromptInput.omitMemory` | builders.ts 已有的动态 memory/notes 跳过逻辑直接复用 |
| §9 子 agent 独立 AC | step-18 不变；本步只加 roleDef 查询，不动 AC wiring | 无回归（smoke-step18 26/26） |
| §8 单文件 ≤ 600 行 | `pool.ts` ~500（增 ~90）；各 builtin ≤ 70；smoke ~330 | 通过 |
| 不硬编码 model/provider 在 prompt | `preferredModel` 是字段不是 prompt 文本；prompt 只读 `ctx.model`（运行时值） | 满足 §9 反模式 |

## 4. 验收标准（spec §验收标准）

| # | 标准 | 实测 | 来源 |
|---|---|---|---|
| 1 | `chovy "用 explore agent 找出所有 .ts 文件"` → 子 agent 实际只读运行 | ✅ | `smoke-step19`: `pool: explore engine sees file_read/glob/grep` + `does NOT see file_edit/bash/agent`（denylist 在 pool 层生效，engine 收到的 tools 已过滤） |
| 2 | explore 试图调 edit 工具时被自身权限白名单拒绝 | ✅ | `smoke-step19`: `pool: explore engine does NOT see file_edit (denylist)` — 工具根本不进入 engine 的 tool pool，模型无法调用 |
| 3 | critic 即使输入"完美方案"也能输出建议 | ✅ | `smoke-step19`: `critic: prompt forbids 'Looks good'` + `has the 'no risks found' fallback` — prompt 结构性禁止橡皮图章，强制输出 risks[] 或显式 "No risks found in this scope, suggested deeper review on X" |
| 4 | checkpoint-writer 在 step-26 验收 | ✅（占位） | `smoke-step19`: `cp: prompt references step-26` + `mentions 8KB cap` + `allowedTools includes file_write`；role 定义已冻结，step-26 填实质内容 |
| — | 类型检查 | ✅ | `bun run typecheck` step-19 文件 0 错（注：`scripts/smoke-step22.ts` 有 4 个 pre-existing 错误，属并行 step-22 工作，非本步引入） |
| — | step-18 兼容性 | ✅ | `bun scripts/smoke-step18.ts` 26/26 通过（无回归） |
| — | step-11 兼容性 | ✅ | `bun scripts/smoke-step11.ts` 45/45 通过（无回归） |
| — | step-19 完整 smoke | ✅ | `bun scripts/smoke-step19.ts` 70/70 通过 |

### 额外覆盖（非 spec 必需但合理）

- `mergeAllowlist` 交集语义（caller 收紧 verify 白名单到仅 bash）✅
- `mergeDenylist` 并集 + 去重 ✅
- 空数组 = no-op（防误杀全部工具）✅
- pool 真跑一轮 explorer（stub provider "ok"）：handle.done + result.content + cost 记账 ✅
- verify 白名单在 pool 层生效：engine 收到的 tools 仅 4 个白名单工具 ✅
- explorer systemPrompt 含 "READ-ONLY"（roleDef.getSystemPrompt 经 buildSystemPromptOpts 进入 Layer-2）✅
- plan 严格模板 5 段（Goal/Approach/Steps/Critical Files/Risks）✅

## 5. Smoke 输出

```
=== Step-19 built-in agents smoke ===

  PASS  registry: 5 built-in roles registered
  PASS  registry: explorer/planner/verifier/critic/checkpoint-writer registered
  PASS  registry: main/custom NOT registered (undefined)
  PASS  explore: disallows file_edit/file_write/bash/agent; allowedTools unset; omitMemory=true; preferredModel small; budget/timeout < default
  PASS  verify: allowedTools === [bash,file_read,grep,glob]; disallowedTools unset; omitMemory=false; file_edit NOT in allowed
  PASS  critic: prompt mentions risks[]/unverified_assumptions[]/edge_cases[]/improvement_suggestions[]; forbids 'Looks good'; has 'no risks found' fallback
  PASS  cp: prompt references step-26; mentions 8KB; allowedTools includes file_read/file_write; omitMemory=true; maxRounds=4
  PASS  merge: allowlist intersection/caller-only/role-only/both-empty→role/both-undefined→undefined
  PASS  merge: denylist union/de-dup/caller-only
  PASS  plan: 5 段模板; omitMemory=false; disallows bash
  PASS  pool: explorer handle done + result.ok + content + systemPrompt 含 READ-ONLY + role===explorer
  PASS  pool: verify engine sees bash/file_read; NOT file_edit/file_write/agent
  PASS  pool: explore engine sees file_read/glob/grep; NOT file_edit/bash/agent
  PASS  pool: caller tighten (tools=["bash"]) → only bash (intersection)
=== 70 passed, 0 failed ===
```

## 6. 工程注意点（移交后续 step）

1. **`roleDef` 查询在 `spawn()` 与 `runChild()` 各查一次**：`spawn()` 需要早查
   （timeout watchdog 在 spawn 里装），`runChild()` 再查一次（合并 config）。
   两次查询都是 O(1) Map.get，无性能问题。若后续 step 想避免重查，可把 roleDef
   放进 `PoolEntry`，但目前无必要。

2. **`systemCtx` 字段稀疏**：step-19 构造的 `SystemContext` 只填 `cwd`/`model`/
   `planMode`（`memoryText`/`notesText`/`loadedSkills`/`contextBudget` 留空）。
   step-25（TMT 注入）会填 `memoryText`；step-27/28（SCW）填 `contextBudget`。
   角色 prompt 当前不应依赖这些字段非空。

3. **`mergeAllowlist` 空数组语义**：空 `[]` = no-op（返回另一侧），**不是**
   "允许零工具"。这是防误杀的安全默认——若 caller 不小心传 `tools:[]`，不应
   让子 agent 失去所有工具。若真要阻塞全部工具，用 `disallowedTools` 列全名。
   doc 注释已写明。

4. **`preferredModel` 是 hint 不是硬约束**：角色设 `preferredModel:"gpt-4o-mini"`，
   但 pool 走 `input.model ?? roleDef?.preferredModel ?? parentCtx.parentModel`。
   若 provider 不支持该 SKU，engine 会在 `provider.complete` 时报错（provider 层
   校验）。step-19 不做 SKU 可用性预检——保持 pool 简单；调用方/ SwarmR（step-20）
   负责选对 provider。

5. **Critic 模型异构未自动强制**：`criticAgent.preferredModel = undefined`（继承父）。
   spec 要求"与父异构"（避免同模型偏见），但 pool 无法自动选异构模型（不知父
   用什么以外的选项）。step-20 SwarmR / 调用方应显式在 SpawnInput 传 `model`
   覆盖。prompt 里 doc 注释说明了这个意图。

6. **`checkpoint-writer` 路径沙箱未实现**：role 定义只标 `allowedTools: ["file_read",
   "file_write"]`，不限制路径。step-26 必须在权限/沙箱层收紧写路径到
   `~/.chovy/projects/<hash>/checkpoints/`。role 定义不是安全边界——prompt 里的
   "只写 checkpoints/" 是指导，不是强制。

7. **`TOOL_PHASE` 映射（step-22 遗留）**：`pool.ts` 的 `TOOL_PHASE` 用 `read`/`write`/
   `edit`，但实际工具名是 `file_read`/`file_write`/`file_edit`。这是 step-22 的
   pre-existing 小 bug（phase 标签会 fallback 到 `running <name>`），非本步引入，
   留给 step-22 修。

## 7. 与 cc-haha 借鉴的对比

借鉴：
- **Explore/Plan/Verify 三角色**：直接借鉴 cc-haha `tools/AgentTool/built-in/`
  （84/93/80 行）。保留：只读约束、并行工具调用、结构化输出、`omitClaudeMd`→
  `omitMemory` 节省 token。
- **`disallowedTools` 防套娃**：cc-haha Explore disallow `AGENT_TOOL_NAME`；chovy
  对应 disallow `agent`。

差异化（坚持创新）：
- **Critic 角色（chovy 新增）**：cc-haha 没有结构化对抗式审阅角色。Critic 与
  Verify 互补（Verify 跑测试，Critic 找盲点），输出 4 段结构化（risks[]/
  unverified_assumptions[]/edge_cases[]/improvement_suggestions[]），禁止橡皮图章。
- **动态 `getSystemPrompt(ctx)`**：cc-haha 用静态 `getSystemPrompt()`（无 ctx）。
  chovy 传 `SystemContext`，让角色 prompt 能读 cwd/model/planMode（如 Verify
  可据项目类型写测试命令）。代价是每次 spawn 调一次函数，但 prompt 质量更高。
- **least-privilege 工具合并**：cc-haha 的 `assembleToolPool` 是简单 allow/disallow；
  chovy 加了交集/并集语义（caller 只能收紧），更贴合 §5 红线。
- **`checkpoint-writer` 占位**：cc-haha 无对应；chovy 为 SCW（step-27/28）预留，
  接口已冻结，step-26 填实质内容即可，不改类型。

## 8. 下一步

按 `docs/README.md §1`：

- step-20 — SwarmR `dispatch(N)`（依赖本步的角色定义 + pool 的 roleDef 合并）
- step-21 — Judge 裁判聚合（依赖 Critic 的结构化输出格式）
- step-22 — Ink UI 子 agent 进度面板（依赖 `subagent.spawn/end` 事件 + handle
  字段 + 本步的 role 标签）
- step-26 — checkpoint-writer 实质内容 + 路径沙箱（依赖本步冻结的 role 定义）

接口冻结后，以上 4 个 step 可在不同 worker 同时推进。
