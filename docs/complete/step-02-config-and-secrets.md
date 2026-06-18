# Step 02 — Config & Secrets · 完成报告

> **关联**：[`docs/step-02-config-and-secrets.md`](../step-02-config-and-secrets.md)
> **Phase**：A · Foundation
> **状态**：✅ 已完成（typecheck 通过，三条验收全部冒烟通过）
> **完成时间**：2026-06-18
> **执行 agent**：main（按 chovy-code 自身 `/goal` 长程任务约定推进）

---

## 1. 目标回顾

在已有 `src/config/config.ts`（zod env 加载）基础上扩展为：

1. 三层（实际四源）配置合并：默认 < `~/.chovy/config.json` < env < CLI flag；
2. 多 provider 密钥的统一读取与缓存；
3. 本地 feature flag 文件 `~/.chovy/features.json`；
4. 每个 provider 的 `<PROVIDER>_BASE_URL` 覆盖。

---

## 2. 产物清单

| 路径 | 类型 | 说明 |
|---|---|---|
| `src/config/config.ts` | **重构** | 四源合并 + zod 校验 + 深冻结缓存 + 扩展 schema |
| `src/config/secrets.ts` | **新增** | API key 与 base URL 解析（env → secrets 文件），带进程内缓存 |
| `src/config/features.ts` | **新增** | 三源 OR 合并的本地 feature flag |
| `src/config/home.ts` | **新增（临时）** | 最小内联 `~/.chovy` 路径解析器（已留 `// TODO step-04`） |
| `src/config/index.ts` | **更新** | barrel 全量导出 |
| `src/cli/index.tsx` | **更新** | 接入 `--feature` / `--permission-mode` / `-t` / `--max-tokens`，启动前 `hasSecret` 检查给 `PROVIDER_NOT_READY` |

行数总览（不含注释）：约 ~340 行新增 + ~30 行修改，保持单文件 ≤ 600 行约束（最大文件 `config.ts` 约 230 行）。

---

## 3. 关键设计决策

### 3.1 四源合并语义（"后者赢"）

```
defaults  <  ~/.chovy/config.json  <  process.env CHOVY_*  <  args
```

- 顶层字段直接覆盖；
- 嵌套对象（`swarm` / `memory` / `context`）走**字段级浅合并**——env 仅设 `swarm.parallelism` 时不会清掉文件里 `swarm.budgetUSD`；
- 验证一律走 `ConfigSchema.parse`，失败时抛 `Error('CONFIG_INVALID: ...')`（待 step-01 升格为 `ChovyError`）；
- 结果 **deepFreeze**，避免上层模块意外改写共享配置。

### 3.2 schema 扩展

新增字段（默认值）：

| 字段 | 默认 | 备注 |
|---|---|---|
| `permissionMode` | `default` | 五种合法值：`default / plan / acceptEdits / auto / bypassPermissions` |
| `swarm.parallelism` | 8 | 软上限，可被 step-20 改 |
| `swarm.maxSubAgents` | 100 | 硬上限，与 ADR §6 一致 |
| `swarm.budgetUSD` | 5 | `/goal` 默认预算（与 AGENTS.md §7.7 一致） |
| `memory.enabled` | true | step-25 注入开关 |
| `memory.injectBudgetTokens` | 4096 | TMT 预算化注入用 |
| `context.softRatio` | 0.75 | SCW 软阈值 |
| `context.hardRatio` | 0.9 | SCW 硬阈值 |
| `context.reserveTokens` | 2048 | SCW 预留 |

**移除**：原 `apiKey` 字段——密钥统一走 `secrets.ts`。这是 step-02 §2 的明确要求（"config.ts 不再认识 apiKey"）。

### 3.3 secrets：env → 文件

```
getSecret(p)   = env[ENV_KEYS[p]]   ??   read(~/.chovy/secrets/<p>)
hasSecret(p)   = getSecret(p) !== undefined
getBaseUrl(p)  = env[<PROVIDER>_BASE_URL]
envKeyFor(p)   = ENV_KEYS[p]                 // 用于错误提示
```

- 进程内 `Map<ProviderId, string|null>` 缓存，避免每次工具调用 stat 文件；
- 文件读取失败仅在 `ENOENT/ENOTDIR` 时静默；其他错误透传；
- **未集成** keychain（按 step-02 §2 显式约束）。

### 3.4 features：三源 OR 合并

```
feature("swarm.judge")
   = setCliFeatureFlags 列表       (CLI: --feature swarm.judge)
  || env CHOVY_FEATURE_SWARM_JUDGE=1
  || ~/.chovy/features.json["swarm.judge"] === true
```

- `dot → underscore`，全大写：`swarm.judge` ↔ `CHOVY_FEATURE_SWARM_JUDGE`；
- 文件解析失败抛 `CONFIG_INVALID`（与 config.ts 一致）；
- 提供 `listEnabledFeatures()` 调试辅助。

### 3.5 PROVIDER_NOT_READY 抢先检查

CLI `action()` 在 `render(<AgentRepl/>)` **之前** 调用 `hasSecret(provider)`，缺密钥时打印：

```
PROVIDER_NOT_READY: Zhipu GLM API key missing.
  Set GLM_API_KEY in your environment, or write the key to ~/.chovy/secrets/glm.
```

并以 exit code 2 退出。这避免了 Ink 启动后才在 `provider.assertReady()` 抛出栈，用户体验更干净。

---

## 4. 验收清单（全部 PASS）

| # | 验收项（来自 step-02 §验收标准） | 实测 |
|---|---|---|
| 1 | `chovy --provider glm "hi"` 在 `GLM_API_KEY` 缺失时给出清晰 `PROVIDER_NOT_READY` | ✅ 见下文复现 |
| 2 | `~/.chovy/config.json` 写入 `{"provider":"kimi"}` 后 default 命令使用 kimi | ✅ |
| 3 | `feature('swarm.judge')` 在 `~/.chovy/features.json` 标 true 时返回 true | ✅ |
| 4（扩展）| env `CHOVY_FEATURE_*` 与 CLI `--feature` 也能各自启用 | ✅ |
| 5（基线）| `bun run typecheck` 无错 | ✅ |

### 4.1 复现脚本

```bash
# 验收 1
bun run src/cli/index.tsx --provider glm "hi"
# → exit 2, "PROVIDER_NOT_READY: Zhipu GLM API key missing. ..."

# 验收 2
export CHOVY_HOME=/tmp/chovy-test
mkdir -p "$CHOVY_HOME"
echo '{"provider":"kimi"}' > "$CHOVY_HOME/config.json"
bun run src/cli/index.tsx
# → "provider=kimi model=(default) permissionMode=default"

# 验收 3
echo '{"swarm.judge":true}' > "$CHOVY_HOME/features.json"
bun -e "import('./src/config/index.ts').then(({feature})=>console.log(feature('swarm.judge')))"
# → true

# 验收 4
CHOVY_FEATURE_GOAL_AUTORUN=1 bun -e "import('./src/config/index.ts').then(({feature})=>console.log(feature('goal.autorun')))"
# → true

# 验收 5
bun run typecheck
# → (no output, exit 0)
```

---

## 5. 已知边界与未做的事（按 AGENTS.md §9 显式列出）

| # | 项 | 原因 |
|---|---|---|
| 1 | 未引入 `ChovyError` 类层次 | 属于 step-01 范围；当前用 `Error('CODE: ...')` 字符串前缀，step-01 完成后批量升格 |
| 2 | 未实现 `~/.chovy/config.json` 的写入路径 | step-04 的 `safeFs.atomicWrite` 才能保证锁竞争安全；本步只读 |
| 3 | 未把 `home.ts` 放在 `src/fs/` 下 | step-04 接管时统一搬迁，迁移点已标 `// TODO step-04` |
| 4 | 未改 `src/providers/openai.ts`、`scaffold.ts` 的 `assertReady` | 属于 step-17（providers 真实接线）；当前在 CLI 层用 `hasSecret` 抢先拦截，已满足验收 |
| 5 | 未集成 keychain | step-02 §2 显式排除 |
| 6 | 未引入 `lodash.merge` 或类似依赖 | 自实现 25 行 `mergeLayer` 即可；保持依赖最小（AGENTS.md §8） |

---

## 6. 屏障 & 接口冻结状态

step-02 不在 `architecture.md §3.3` 的"接口冻结时点"列表里，但其暴露的下列符号是 **后续步骤的稳定 API**，请避免私改签名：

```ts
// src/config/index.ts barrel
loadConfig(opts?: LoadConfigOptions): ChovyConfig
resetConfigCache(): void

getSecret(p: ProviderId): string | undefined
hasSecret(p: ProviderId): boolean
getBaseUrl(p: ProviderId): string | undefined
envKeyFor(p: ProviderId): string

feature(name: string): boolean
setCliFeatureFlags(flags: readonly string[]): void
listEnabledFeatures(): string[]

// 类型
type ChovyConfig
type PartialConfig
type PermissionMode
type LoadConfigOptions
```

下游消费方将主要在 step-12（permission engine 读 `permissionMode`）、step-17（provider 读 `getSecret/getBaseUrl`）、step-20（swarm 读 `swarm.*`）、step-25（memory 读 `memory.*`）、step-27（context 读 `context.*`）。

---

## 7. 未触碰区域（按 §9 反模式清单核对）

- ❌ 未"顺手清理 / 重构"未要求修改的代码
- ❌ 未触碰 5 项创新（ATP/SwarmR/TMT/SCW/CSG）的实现位置
- ❌ 未在工具描述里写超长 prompt（本步不涉及工具）
- ❌ 未修改 `bin/chovy.js`（构建产物）
- ❌ 未引入新依赖
- ❌ 未删除任何文件
- ❌ 未触碰 `.git/` 等敏感目录

---

## 8. 后续工作衔接

| 谁 | 做什么 |
|---|---|
| **step-01**（types & errors） | 定义 `ChovyError` 后，把本步 4 处 `throw new Error('XXX_INVALID: ...')` 升格为 `throw new ChovyError('XXX_INVALID', ...)` |
| **step-04**（fs & paths） | 将 `src/config/home.ts` 迁入 `src/fs/home.ts`；新增 `ensureHomeDirs()` 在 CLI 启动时建目录；让 secrets/features 的 `readFileSync` 走 `safeFs` |
| **step-05**（cli shell） | 将 `--feature` / `--permission-mode` 全局选项下沉到 `src/cli/index.tsx` 之外的子命令，并在交互式 REPL 里提供 `:feature` 切换 |
| **step-12**（permission engine） | 读取 `config.permissionMode` 决定 6 层决策默认行为 |
| **step-17**（providers real） | 用 `getSecret(p)` / `getBaseUrl(p)` 替换 `process.env[INFO.envKey]`；让 `assertReady()` 抛 `ChovyError('PROVIDER_NOT_READY', ...)` |
| **step-20**（swarm router） | 读 `config.swarm.parallelism` / `maxSubAgents` / `budgetUSD` |
| **step-25 / 27**（memory inject、context monitor） | 读 `config.memory.*` / `config.context.*` |

---

## 9. 风险登记（沉淀到本仓库知识库）

| # | 风险 | 当前处置 | 后续 |
|---|---|---|---|
| R-02-1 | 缓存导致测试间状态污染 | 提供 `resetConfigCache / resetSecretsCache / resetFeaturesCache` | 等 step-30 e2e 增加测试套件时统一在 `beforeEach` 调用 |
| R-02-2 | Windows 路径分隔符 | 全部走 `node:path.join`，并实测 `D:\` 风格路径正常 | step-04 跨平台测试再覆盖 |
| R-02-3 | secrets 文件明文落盘 | 文档里提示用户自行控制权限（0600） | step-12+ 评估是否引入 OS keyring，但 ADR §10 已倾向不引入 |
| R-02-4 | 三源 feature flag 不一致 | OR 合并语义文档化；`listEnabledFeatures()` 提供统一视图 | 若出现"想强制关闭"的诉求再改成显式 false 优先 |

---

**结论**：step-02 完整落地，所有验收标准通过，未破坏屏障接口，未跨界改动。可以安全进入 step-01 / step-03 / step-04 的并行开发。
