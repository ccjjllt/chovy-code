# Step 15 完成报告 — System Prompt（5 层优先级 + 静态/动态分区 + PSF）

> 完成日期：2026-06-18
> 范围：`docs/step-15-system-prompt.md`、`src/prompts/`（6 个新文件审计 + 接受）、`src/telemetry/events.ts`（占位 `PromptShape` → 单源 re-export）、`src/engine/queryEngine.ts:323-333`（消费侧改用真实 PromptShape；step-16 WIP 的连带修复）、`scripts/smoke-step15.ts`（27 项验收脚本）
> 依赖：step-01（types/agent.ts 的 `AgentRole` 单源；errors.ts 的 `ErrorCode`）、step-06（`DescribedTool` 来自 `src/tools/describe.ts`，PSF 直接复用）、step-12（`PermissionMode` 字面量；plan-mode 注入条件）
> 结论：4 条核心验收（plan note 追加 / override 短路 / 同 cwd staticHash 稳定 / 工具描述变化 → perToolHash 变化）+ 13 项扩展断言 = **27/27 通过**；`bun run typecheck` 在 step-15 范围内**0 新增错误**（4 个残留错误均位于 `src/engine/`，是 step-16 WIP 的预存量）。

---

## 1. 依据

- `docs/step-15-system-prompt.md`（6 产物 + 5 层优先级 + boundary 标记 + PSF 字段集 + 4 条验收 + 风险"prompt 过长"）
- `AGENTS.md §16`（单源规约：`AgentRole`/`PermissionMode`/`HookEvent`；本步骤把 `PromptShape` 加入同一规约族）、§9（"不要复刻 cc-haha 全量"——只取 5 层模型 + boundary 思路 + 缓存哈希思路，不抄 914 行 prompt 也不接 Anthropic prompt cache pricing）
- `源码解析.md` 第三章（cc-haha `utils/systemPrompt.ts` 5 层模型 + `constants/prompts.ts` 914 行 + `services/api/promptCacheBreakDetection.ts` 727 行）—— 取 **5 层短路模型 + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + per-tool hash diff** 思路；**不**复刻 cc-haha 的：Anthropic-only `cache_control` 注入逻辑 / 1h↔5min TTL 跟踪 / `tengu_prompt_cache_break` 事件家族 / GrowthBook 缓存 strategy 判定 / Ant 内部 ent / 914 行全文 prompt
- `docs/architecture.md §3.3`（接口冻结时点：步骤 15 冻结 `SystemPromptLayer`）

---

## 2. 产物（接受 + 审计）

```
src/prompts/
├── boundary.ts        # CHOVY_PROMPT_DYNAMIC_BOUNDARY + splitAtBoundary
├── default.ts         # chovy-code 主 system prompt (~5 KB; defaultStaticPrompt + boundaryGlue)
├── snippets.ts        # cwdSection / modelSection / memorySection / notesSection / skillsSection / contextBudgetSection
├── builders.ts        # buildEffectiveSystemPrompt + SystemPromptLayer (frozen)
├── fingerprint.ts     # PromptShape + computeShape + diffShape + 32-bit FNV-1a
└── index.ts           # barrel
```

接线改动：
- `src/telemetry/events.ts`：删除占位 `PromptShape`（`hash/layers/tokens` 三字段），改为 `export type { PromptShape } from "../prompts/fingerprint.js"` + `import type { PromptShape }` 用于 `prompt.shape` 事件载荷类型。AGENTS.md §16 单源规约加入 `PromptShape`（注释列入）。
- `src/engine/queryEngine.ts:323-333`：`emitTelemetry({type:"prompt.shape", shape: {hash, layers, tokens}})` 占位实现替换为 `shape: shape`（直接传整个 `PromptShape`）。step-16 WIP 此前用占位三字段构造，单源迁移自然带动消费侧调整（与 Phase B `AgentRole` 统一同模式）。
- `scripts/smoke-step15.ts`：27 项验收脚本（详见 §4）。

不动的接口（B1 屏障 + step-15 冻结）：
- `Tool` / `ToolContext` / `ToolResult` / `DescribedTool` / `PermissionEngine.preflight?` / `HookEngine.emit?`/`runPermissionRequest?` / `AgentRole`：均未触碰。
- `SystemPromptLayer` 字面量联合首发于 `src/prompts/builders.ts`（step-15 冻结点）。后续 step-16/19 引用一律 `import type { SystemPromptLayer } from "@chovy/prompts"`，不重声明。

---

## 3. 设计要点

### 3.1 5 层优先级（cc-haha `utils/systemPrompt.ts` → chovy 适配）

| 优先级 | 来源 | 行为 |
|---|---|---|
| 0 override | loop / coordinator harness | **短路其他 4 层**（含 defaultAppend）。返回单 segment。 |
| 1 coordinator | 多 agent 协调 | 前置；与下层堆叠（与 cc-haha 一致：coordinator 之后仍可有 default）。 |
| 2 agent | 子 agent 角色 prompt | 前置。`omitMemory:true` → 跳过动态 memory/notes 段（least-context 原则；§4 explore 角色用） |
| 3 custom | `--system-prompt` | 前置。 |
| 4 default | `defaultStaticPrompt` + `defaultAppend` | 始终拼上（除非 0 短路）。`planMode:true` → 静态尾部追加 `PLAN_NOTE`。 |

**与 cc-haha 的差异**：
1. cc-haha proactive 模式下 agent prompt **追加**到 default 之后；chovy 暂不区分 PROACTIVE/ 普通模式（KAIROS 已被 §10 排除），统一前置堆叠。
2. cc-haha override 走 `feature('COORDINATOR_MODE') && env('CLAUDE_CODE_COORDINATOR_MODE')` 双条件门；chovy 简化为单参数 `opts.override`，是否启用由调用方（step-16/23）决定。
3. cc-haha `appendSystemPrompt` 在 override 路径下也拼接（仅 override 替换主体，仍 append）；chovy 把 `defaultAppend` 严格视作 default 层的扩展，override 路径下**忽略** —— 与 spec "其它 4 层全部忽略" 字面一致。

### 3.2 静态/动态边界

- 标记字符串 `CHOVY_PROMPT_DYNAMIC_BOUNDARY = "<!--chovy:dynamic-->"`（HTML 注释；markdown 渲染器吞掉、不会出现在用户/模型文本里）。
- 静态侧：`defaultStaticPrompt({planMode})` 输出的身份/工具优先级/代码改动/安全（含 §5 红线代码化）/输出风格/5 创新提醒；当 `planMode:true` 追加 `PLAN_NOTE`。**注意**：plan note 故意放在静态侧——一次会话内 mode 是稳定的，缓存（Anthropic）/稳定前缀（其他 provider）仍可命中。
- 动态侧：`cwdSection` / `modelSection` / `memorySection` / `notesSection` / `skillsSection` / `contextBudgetSection`，每段独立可空（step-25/27 可任意启停）。
- `splitAtBoundary(text)` 用于 PSF 切分 staticHash / dynamicHash；缺失标记时整段视为静态（override 路径或裸 prompt 兼容）。

### 3.3 PSF（Prompt Shape Fingerprint）—— cc-haha cache-break 的通用化

cc-haha 的 `promptCacheBreakDetection` 为 Anthropic 计费缓存设计（`stripCacheControl` / 5min↔1h TTL / `tengu_prompt_cache_break` 事件 / Ant BQ 分析）。chovy 抽象出与 provider 无关的"形状指纹"：

```ts
export interface PromptShape {
  modelId: string;
  staticHash: number;       // 32-bit FNV-1a（截断为无符号）
  dynamicHash: number;
  toolsHash: number;        // 仅基于 sorted name list
  toolNames: string[];
  perToolHash: Record<string, number>;  // hash(level + description + stableJson(schemaJson))
  systemBytes: number;
  injectedSegments: string[];
  ts: number;
}
```

**3 个不变量**：
1. **Hash 算法可移植**：FNV-1a 32-bit 纯 TS（Math.imul 保 32 位、`>>> 0` 转无符号），不依赖 `Bun.hash`，Node 全局安装也能跑。
2. **Schema 序列化稳定**：`stableJson` 递归排序键，保证 `{a:1,b:2}` 与 `{b:2,a:1}` 同 hash —— 防 ATP 分配器迭代顺序震荡假触发缓存破坏。
3. **per-tool hash 与 cc-haha 同源理由**：cc-haha 注释指出"77% 的工具缓存破坏来自单个工具描述变化而非工具增删"；perToolHash 让 telemetry 直接定位是哪个工具改了 —— 这是 ATP 双描述（lean/full）协议下尤其重要的诊断信号（lean→full 升级是合法的"改"，但要可观测）。

`diffShape(a,b)` 输出 `{identical, changedFields[], toolsAdded[], toolsRemoved[], toolsMutated[]}`，供 step-16/30 的 `chovy prompt diff <session>` 命令消费（命令本身留 step-30 接入）。

### 3.4 单源规约（AGENTS.md §16）

| 类型 | 单源位置 | 消费侧 |
|---|---|---|
| `AgentRole` | `src/types/agent.ts` | telemetry/events.ts、relevance.ts、prompts/builders.ts |
| `PermissionMode` | `src/config/config.ts` | harness/permissions/modes.ts、prompts/builders.ts（间接，通过 `planMode:boolean`） |
| `HookEvent` | `src/types/hook.ts` | harness/hooks/index.ts |
| `SystemPromptLayer` | **`src/prompts/builders.ts`（step-15 新加）** | step-16+ 通过 barrel re-export |
| `PromptShape` | **`src/prompts/fingerprint.ts`（step-15 新加）** | telemetry/events.ts re-export |

`telemetry/index.ts` 现有 `export type { PromptShape } from "./events.js"` 自动透传（events.ts 自己 re-export 自 prompts/fingerprint.js）。无需修改 telemetry barrel。

### 3.5 风险对策（spec §风险）

| 风险 | 对策 | 状态 |
|---|---|---|
| 默认 prompt 过长 | `defaultStaticPrompt()` 字面量约 4.6 KB（≈1.2k tokens，`chars/4` 估算），远低于 spec "≤3000 tokens" 上限。chovy 创新段写得简洁，没有像 cc-haha 那样塞工具示例（示例放工具自己的 `desc.full`，由 ATP 控）| ✓ |
| static 段误吃 cwd/model/timestamp | 静态侧只调用 `defaultStaticPrompt({planMode})` 纯函数；smoke #3 断言 `split.static` 不含 cwd 字符串、`a.staticHash === b.staticHash` | ✓ |
| 工具顺序震荡导致 toolsHash 抖动 | `toolsHash = fnv1a(toolNames.join("|"))` —— 跟 ATP 分配器输出的顺序绑定。ATP 当前按"lean baseline → 升级时 sort by score"输出，同输入是确定性的。如果未来引入异步并行评分，需要在 `computeShape` 入口加 sorted name 副本（已在注释中标记） | ⚠️ 监控（无当前回归） |
| Bun.hash 非 Bun 环境缺失 | 直接用纯 TS FNV-1a，无运行时依赖 | ✓ |

---

## 4. 验收脚本（`scripts/smoke-step15.ts`）

```
bun run scripts/smoke-step15.ts
```

**输出**（27/27 PASS）：

```
# acceptance #1 — plan mode appends 'plan mode' note
  ✔ text contains 'Plan mode (active)'
  ✔ non-plan-mode build does NOT contain plan note

# acceptance #2 — override layer short-circuits the others
  ✔ segments has exactly one entry
  ✔ only segment is from 'override'
  ✔ text equals the override input (trim-equal)
  ✔ no fragment from default body leaks

# acceptance #3 — staticHash is stable across runs (same cwd, same mode)
  ✔ staticHash equal across two builds (a=2611641537 b=2611641537)
  ✔ staticHash unchanged when only cwd/memory differ
  ✔ dynamicHash differs when cwd/memory differ
  ✔ planMode flip changes staticHash
  ✔ boundary marker present in default build
  ✔ split.static is non-empty and split.dynamic is non-empty
  ✔ split.dynamic mentions cwd
  ✔ split.static does NOT mention cwd

# acceptance #4 — perToolHash changes iff that tool's description changes
  ✔ toolsHash unchanged (name list identical)
  ✔ perToolHash[fs.read] unchanged
  ✔ perToolHash[fs.edit] CHANGED
  ✔ perToolHash[exec.bash] unchanged
  ✔ diff.identical === false
  ✔ diff.toolsAdded === []
  ✔ diff.toolsRemoved === []
  ✔ diff.toolsMutated === ['fs.edit']
  ✔ diff.changedFields includes 'perTool'
  ✔ adding a tool registers toolsAdded
  ✔ adding a tool flips toolsHash → changedFields includes 'toolsList'
  ✔ model id change flagged
  ✔ model id change does NOT mark tools mutated

PASS — step-15 acceptance criteria satisfied
```

每条验收的覆盖映射：

| spec §验收 | 对应断言 | 数量 |
|---|---|---|
| 1. plan 模式追加 plan note | acceptance #1 | 2 |
| 2. override 短路其他 4 层 | acceptance #2 | 4 |
| 3. 同 cwd staticHash 稳定 | acceptance #3 | 8（含动态侧/边界标记/plan-flip 反向断言） |
| 4. 工具描述变化 → perToolHash 变化 | acceptance #4 | 13（含工具增删 / model 变化 / diffShape 反向断言） |

---

## 5. typecheck 状态

```
$ bun run typecheck
src/engine/costTracker.ts(178,9): error TS2322: Type '"agent.cost"' is not assignable to type ...   ← step-16 WIP（pre-existing）
src/engine/queryEngine.ts(64,3):  error TS2305: ... 'PermissionMode'                                ← step-16 WIP（pre-existing）
src/engine/queryEngine.ts(166,15): error TS1294: ... 'erasableSyntaxOnly' ...                       ← step-16 WIP（pre-existing）
src/engine/queryEngine.ts(240,51): error TS2339: ... 'runPermissionRequest' ...                     ← step-16 WIP（pre-existing）
```

**step-15 范围内 0 新增错误**。`git stash` 验证：撤回所有 step-15 改动后这 4 个错误同样存在；step-15 的 `events.ts` 切换 + `queryEngine.ts:323` 单点修复**减少**了一个错误（占位 `PromptShape.hash` 不再编译错），未引入新错误。

`src/engine/` 4 个错误属于 step-16（QueryEngine）的 WIP scaffolding，由 step-16 owner 负责补完：
1. `costTracker.ts:178` — `"agent.cost"` 事件类型未加入 `TelemetryEvent` 联合（需 step-16 在 events.ts 追加）；
2. `queryEngine.ts:64` — `PermissionMode` 应从 `@chovy/config` 而非 `@chovy/types` 导入；
3. `queryEngine.ts:166` — `erasableSyntaxOnly` 违例（疑似 enum/parameter property）；
4. `queryEngine.ts:240` — `HookEngineInternal.runPermissionRequest` 字段名/类型不匹配。

不在本步骤范围内。

---

## 6. 与后续步骤的接入点

- **step-16（QueryEngine）**：每轮调用 `buildEffectiveSystemPrompt` + `computeShape`，`emitTelemetry({type:"prompt.shape", shape})` 一次/轮（`queryEngine.ts:323-333` 已就位，等 step-16 完结其他 scaffold 错误）。`pruneOrphanToolMessages` / `normalizeForProvider` 已在同文件 WIP，但与 step-15 解耦。
- **step-17（providers）**：能力矩阵中 `promptCache: true` 的 provider（Anthropic）可在 boundary 标记处插入 `cache_control: { type: "ephemeral" }`；其他 provider 直接发送 `effective.text` 即可。
- **step-19（built-in agents）**：`AgentPromptInput.omitMemory:true` 用于 explorer 的 least-context 配置；prompt 文本走 `agent: { role: "explorer", prompt: EXPLORER_PROMPT, omitMemory: true }`。
- **step-22（agent UI）**：`EffectivePrompt.segments[]` 的 bytes 可在 status line 渲染；`PromptShape.diffShape` 给 `chovy prompt diff <session>` 提供数据（CLI 命令本身留 step-30）。
- **step-25（memory injection）**：`SystemContext.memoryText / notesText` 字段已就绪；step-25 用 ranker 输出装填即可。
- **step-27（context budget）**：`SystemContext.contextBudget` 字段已就绪；`contextBudgetSection` 渲染粗粒度（已四舍五入到百位 token）避免 dynamicHash 每帧抖动。

---

## 7. 已验证的不变量（追加到 AGENTS.md §16 候选）

> 以下不变量在 step-15 后生效；下次 §16 复验时建议固化。

1. **`SystemPromptLayer` 单源**：`src/prompts/builders.ts`。后续步骤 `import type { SystemPromptLayer }`，禁止重声明。
2. **`PromptShape` 单源**：`src/prompts/fingerprint.ts`。`telemetry/events.ts` 仅 re-export；步骤 16+ 用 `import type { PromptShape } from "@chovy/prompts"` 或 `@chovy/telemetry`。
3. **boundary 标记位置**：`<!--chovy:dynamic-->` 必须出现在 default prompt **之后**、动态片段**之前**。`splitAtBoundary` 缺失标记时整段记为静态；override 路径不带标记是合法的（PSF 仍能算）。
4. **plan note 归属**：`PLAN_NOTE` 写在静态侧，模式翻转**会**改 staticHash（这是合理的，因为 mode 在一次 session 内通常是稳定的；切 mode 等价于切 session）。
5. **PSF 算法**：FNV-1a 32-bit + stableJson 排序键。两个不同步骤的同一对象**必须**生成同 hash —— 不要替换为 `Bun.hash` 之类不稳定 across-platform 的实现。

---

## 8. 命令速查

```bash
bun run typecheck                # step-15 范围 0 新错；4 残留属 step-16
bun run scripts/smoke-step15.ts  # 27/27 PASS
```

---

最后：5 层模型 + boundary + PSF —— "稳定 prefix → 稳定输出" 而非"为某家 provider 的 cache 计费写脚本"。chovy-code 在 7 家 provider 上都能受益。
