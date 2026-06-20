# Step 21 — Judge Aggregator 验收报告

> 范围：`docs/step-21-judge-aggregator.md`（Phase E，依赖 20）。
> SwarmR 的"裁判模型"半边——把 N 个子 agent 的结果按 *zod 强约束 schema* 聚合，
> 给出结构化判定（`JudgedAggregate`），主 agent 可机器读而非自然语言总结。
> 与 step-20 dispatch 核心互补：dispatch 负责 fan-out + 收集，judge 负责
> 结构化整合。

## 1. 产物清单

```
src/swarm/
├── judge.ts              # runJudge 主入口：provider 选择 + callWithRepair + 截断 + JudgedAggregate
├── schemas.ts            # 4 种内置 zod schema（Consensus/Compare/Rank/CustomMeta）+ schemaFor 选择器
├── prompts/
│   ├── consensus.txt     # 裁判系统提示（一致性判定）
│   ├── compare.txt       # 两两对比
│   ├── rank.txt          # 打分排序
│   └── meta.txt          # 自定义抽取
├── router.ts             # 替换 JUDGE 留桩 → 真实 runJudge（成本折进 totalCostUSD）
└── index.ts              # barrel 导出 runJudge / tryFixJSON / 4 schema / JudgedAggregate

src/tools/meta/dispatch.ts # docstring 更新（judge 已上线）+ summarizeDispatch 渲染 JudgedAggregate
scripts/smoke-step20.ts     # 测试 #9 更新：judge.enabled 现在真实调用（deps.runJudge 注入 stub）
scripts/smoke-step21.ts     # 离线冒烟（50 项断言，全过）

AGENTS.md                  # §3 状态行 + §18「Judge 聚合不变量」固化
```

## 2. 流程对照表（与 step-21 §流程 一致）

| 步骤 | 实现位置 |
|---|---|
| ① 拼接输入：N 个结果包成 `<agent id role status><content/></agent>` | `assembleInput()` + `escAttr/escXml` |
| ② 加 schema 提示词（"输出符合 zod 结构的 JSON"） | `buildSystemPrompt()` + `stringifySchema()`（zod `.toJSON()`） |
| ③ provider 支持 json-mode 时强制 JSON；否则约束 + 后处理 tryFixJSON | `callProvider()` temperature=0 + `tryFixJSON()`（无 response_format 旋钮 → 靠 prompt + repair） |
| ④ zod parse；失败 → 重试一次（最多 1 次自我修复） | `runJudge()` for 循环 attempt 0..1 + `buildRepairUserMessage()` |
| ⑤ 仍失败 → 降级返回 raw text + ok=false | `runJudge()` 末尾 `reason:'parse'` 返回 |

## 3. 验收标准对照（step-21 §验收标准）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 3 个 sub agent（disagree）→ Consensus 输出 split 且 evidence 数=3 | ✅ | smoke `consensus`：agreement=split，evidence.length===3，attempts=0 |
| 2 | 全员 ok=false → judge 仍能返回 conflict + unresolved | ✅ | smoke `all-failed`：agreement=conflict，unresolved 非空 |
| 3 | json-mode 可用时 100% schema parse 成功 | ✅ | smoke `json-mode`：clean JSON 一次过，attempts=0，ok=true |
| 4 | 不可用时通过 tryFixJSON 兜底 ≥ 95% 成功 | ✅ | smoke `messy`：fences+prose 包裹的 JSON 经 tryFixJSON 恢复，ok=true |

额外覆盖（非 spec 明列但关键不变量）：

- **自我修复**：首次缺 `final_answer` 字段 → repair 调用补全 → ok=true，attempts=1（smoke `repair`）。
- **双次失败**：两次都返回非 JSON prose → ok=false，reason=parse，attempts=1，rawText 保留（smoke `parse-fail`）。
- **无 provider**：fallback 链 + 父 provider 全无 secret → ok=false，reason=no-provider，**不抛**（smoke `no-provider`）。
- **compare/rank/custom** 三种 schema 各自形状校验通过（smoke `compare`/`rank`/`custom`）。
- **截断**：10KB agent content 不撑爆，judge 仍成功（smoke `trunc`）。
- **取消**：abortSignal 已 abort → ok=false，reason=cancelled，costUSD=0，未调用 provider（smoke `cancel`）。
- **tryFixJSON 单元**：clean/fenced/prose-wrapped/truncated-object/truncated-array 全恢复（smoke `fix` 6 项）。
- **schema 单元**：ConsensusSchema/CompareSchema/RankSchema/CustomMeta 各自 validate + reject（smoke `schema` 6 项）。
- **router 集成**：judge.enabled → runJudge 被调用，judgement 透传，judge cost 折进 totalCostUSD（smoke-step20 `judge` 6 项）。
- **judge 禁用**：judge.enabled=false → 不调用，judgement=undefined（smoke-step20 `judge: disabled`）。

## 4. 关键设计决策

### 4.1 judge 不是 telemetry 源（§17/§18 单源延续）

judge 的 `CostTracker` 实例用 `telemetry:false` 构造——judge **不** emit `agent.cost`
事件。judge cost 折进 dispatch 的 `totalCostUSD`（router 在 judge 返回后
`totalCostUSD += judgement.costUSD`），但 `swarm.dispatch` 仍是每 dispatch 唯一
telemetry 事件（§17 单源）。这避免 judge 调用产生与 sub-agent cost 混淆的
独立 telemetry 流。

### 4.2 judge 失败不致命（§18 冻结 stopReason）

judge 的任何失败（parse / cancelled / no-provider）都走 `judgement.ok=false` +
`reason` 字段，**不**新增 `DispatchOutput.stopReason`（§18 冻结
`final`/`budgetExceeded`/`cancelled`）。主 agent 仍拿到原始 `results[]`，
judge 是增强而非阻塞——这匹配 step-20 §验收"judge 留桩"的不变量精神
（即便 judge 完全没跑，dispatch 也该返回可用结果）。

### 4.3 provider 选择：caller 覆盖 → 长上下文 fallback 链 → 父 provider

`pickJudgeProvider()` 三级优先：

1. **caller `judge.provider/model`**（显式覆盖）——经 `hasSecret` 门控；未配置
   则 fall through（不抛）。
2. **fallback 链**（长上下文优先）：Kimi-K2 (256k) → GLM-4.5 (128k) →
   DeepSeek-V3 (128k) → Gemini-2.5-pro (1M) → Claude Sonnet 4 (200k)。每条经
   `hasSecret` 门控；`judge.model` 覆盖链默认 model id。
3. **父 provider**（best-effort）——也经 `hasSecret`；dispatch 跑通意味着父
   provider 大概率有 key。

全部不可用 → `ok=false / reason:'no-provider'`，**不**抛（§18）。这保证无 API
key 的离线/CI 环境下 dispatch 仍返回可用结果。

### 4.4 取消传播：judge 本地 AC 包装 dispatch ac.signal（§9 红线）

judge 用**本地** `AbortController` 包装 `opts.abortSignal`（dispatch 的 `ac.signal`），
**不**共享 dispatch signal 对象。dispatch 已 abort 时 router 跳过 judge 调用
（`judgement` 留 `undefined`）；judge 运行中 dispatch abort → judge 感知 →
`ok=false / reason:'cancelled'`，**不**抛。fetch `AbortError` 在 provider 层
rethrow（§17），judge 的 try/catch 识别 `AbortError` → cancelled 路径。

### 4.5 tryFixJSON：去包裹 + 截首尾 prose + 补缺括号

`tryFixJSON()` 五步防御性修复（每步幂等、不适用则 no-op）：

1. 去掉 ` ```json ... ``` ` 代码块包裹；
2. 去掉首个 `{`/`[` 之前的 prose；
3. 去掉最后一个 `}`/`]` 之后的 prose；
4. 大括号不平衡时双策略：(a) 切到最后一个平衡闭包；(b) `appendMissingClosers`
   追加缺失的 `}`/`]`（LIFO 栈追踪 `{`/`[`）——处理真正截断的输出；
5. `JSON.parse` 成功返回对象；失败返回修复后的字符串（zod 报真实 shape 问题）。

策略 (b) 是关键创新：模型 token 用尽时输出可能停在 `"confidence":0.5`（无
闭 `}`），`appendMissingClosers` 追踪开括号栈 + 追加匹配闭包，把残缺 JSON
修成可解析。smoke `fix: truncated JSON recovers` + `fix: truncated array recovers`
验证两条路径。

### 4.6 自我修复 ≤1 次（spec §自我修复）

第一次 `safeParse` 失败 → `buildRepairUserMessage()` 构造 repair prompt：
echo 上次 raw 输出 + zod `issues`（path / message / code，截断到 10 条）+
原始输入。第二次调用用 repair prompt。仍失败 → `ok=false / reason:'parse'`，
`rawText` 保留。spec 上限是 1 次修复（共 2 次调用），代码 `for (attempt 0..1)`
精确对齐。

### 4.7 大 N 截断（spec §风险）

`assembleInput()` 对每个 agent content 截断到 ≤ 4 KB（首 2 KB + 尾 2 KB，
中间插 `…[truncated]…`）。`buildSystemPrompt()` 在输入概况里标注"部分 agent
内容已截断"。`Buffer.byteLength` + `sliceBytes` 按 UTF-8 字节偏移切（surrogate
安全）。避免 N 个子 agent 完整 transcript 撑爆 judge provider ctx。

### 4.8 依赖图无环

`judge.ts` import：
- `engine/costTracker.js`（叶子：只 reach logger/telemetry/capabilities/types，不
  回 swarm）✅
- `providers/index.js` + `providers/capabilities.js`（叶子）✅
- `config/secrets.js`（叶子）✅
- `./schemas.js`（同模块叶子）✅
- `./router.js`（**type-only**：`import type { DispatchChildResult, ... }`）✅

`router.ts` import `./judge.js`（value：`runJudge`）。judge 不 import router 的
value，只 import type → **无环**。这与 step-20 §4.2 的 `swarm/pool.ts` reach
`agent/pool.js` 叶子模式一致（DAG）。

### 4.9 `DispatchDeps.runJudge?` 注入（测试隔离）

router 的 `DispatchDeps` 追加 `runJudge?: typeof runJudge`（§16 兼容：追加可选
字段）。离线 smoke（smoke-step20 #9）注入 stub verifier 返回 canned
`JudgedAggregate`，不命中真实 provider。生产路径 `deps.runJudge ?? runJudge` 走
真实 `runJudge`。这与 `deps.pool` / `deps.bus` / `deps.limiter` 同模式。

### 4.10 prompt 内联 + .txt 单源

`judge.ts` 把 4 个 prompt 内联为常量（`CONSENSUS_PROMPT` 等），`loadPrompt()`
按 schemaName 选择。`src/swarm/prompts/*.txt` 是人类可编辑的 canonical 源；
内联常量镜像它们，使 judge 零 fs 依赖、自包含（测试 / 打包友好）。两者需保持
同步（smoke 未加 drift check，但内容当前一致）。

## 5. 不变量（写入 AGENTS.md §18）

§18「Judge 留桩不变量（step-21 前）」替换为「Judge 聚合不变量（step-21）」，
固化 8 条跨步骤约束：

- judge 不是 telemetry 源（costTracker `telemetry:false`）；
- judge 失败不致命（`ok=false` + reason，stopReason 不变）；
- judge 取消独立 signal（本地 AC 包装 dispatch ac）；
- provider fallback 链（caller → 长上下文链 → 父，全经 hasSecret）；
- schema 单源（schemas.ts，router 不重声明 union）；
- 自我修复 ≤1 次（repair prompt echo raw + issues）；
- 大 N 截断（≤4 KB/agent，首尾保留）；
- `DispatchDeps.runJudge?` 测试注入。

## 6. 冒烟结果

```
=== Step-21 Judge Aggregator smoke ===
  (50 项断言)
=== 50 passed, 0 failed ===
```

离线运行：`bun scripts/smoke-step21.ts`（无网络 / 无 TTY / 无真实 provider；
全部走 stub provider，env key 注入使 hasSecret=true）。

回归：
- `bun scripts/smoke-step20.ts` → 50/50 通过（测试 #9 更新为真实 judge 接线）。
- `bun scripts/smoke-step22.ts` → 37/37 通过（UI 面板未受影响）。
- `bun run typecheck` → 0 错误。
- `bun run build` → 成功（756.3 KB，bin/chovy.js 产物正常）。

## 7. 风险与遗留

- **json-mode 未走 response_format**：`ProviderRequestOptions` 无 `response_format`
  旋钮（step-17 冻结签名未含），judge 靠 prompt 强约束 + `tryFixJSON` 兜底，而非
  OpenAI `response_format: { type: 'json_object' }`。spec §流程 第 3 步说"provider
  支持 json-mode 时强制 JSON；否则仅约束 + 后处理"——当前实现统一走后者。后续若
  给 `ProviderRequestOptions` 追加 `responseFormat?` 可选字段，judge 可对
  `supportsJsonMode:true` 的 provider 启用硬约束（100% parse，省一次 repair）。
- **prompt 内联 vs .txt drift**：`judge.ts` 内联常量镜像 `prompts/*.txt`，当前一致
  但无自动 drift check。后续可加 build-time 校验或改用 fs 读盘（judge 在进程内，
  cwd 稳定）。
- **judge 不流式**：judge 用 `provider.complete()`（非 `stream()`），因为输出是短
  JSON 判定，流式无 UI 价值且增加复杂度。step-22 UI 面板若想显示 judge 进度，可
  订阅 dispatch 的 swarmBus（judge 不单独发 bus 事件）。
- **custom schema 仅运行时校验**：`judge.customSchema` 是 `unknown`（wire schema
  不强约束 zod），`schemaFor()` 用 `isZodSchema()` duck-type 校验。非 zod 对象
  fallback 到 `CustomMeta(z.unknown())`——judge 仍返回 `{ items: [...] }` 但不校验
  内部形状。
- **无真实 provider 集成测试**：smoke 全走 stub。真实 7 provider 的 judge 调用
  （含 json-mode 硬约束 / SSE 中断 / 速率限制）留给 step-30 端到端或手动
  `chovy goal` 验证。
