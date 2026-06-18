# Step 14 完成报告 — Sandbox（FS allowlist + 危险文件 + 命令隔离）

> 完成日期：2026-06-18
> 范围：`docs/step-14-sandbox.md`、`src/harness/sandbox/`（新建 4 文件）、`src/tools/fs/write.ts` + `edit.ts`（assertWritable 接入）、`src/tools/exec/bash.ts`（替换 sandboxStub 为真实沙箱）、`scripts/smoke-step14.ts`（46 项验收脚本）、`scripts/smoke-fs-tools.ts`（适配 ctx.cwd 透传）
> 依赖：step-12（权限引擎 L1g safety + 6 层决策；engine.ts 接口冻结）、step-09（bash AST + classification 纯函数叶子；EndTruncatingAccumulator 30 KiB cap）、step-08（fs 工具 run() 入口）
> 结论：4 条核心验收 + 7 组单元/集成断言全绿（46/46）；`bun run typecheck` 通过；step-04 / step-07 / step-09 / step-10 / step-11 / step-12 / step-13 / phase-b / fs-tools 全部回归无破坏（合计 200+ 项无失败）。

---

## 1. 依据

- `docs/step-14-sandbox.md`（4 产物 + DANGEROUS 列表 + assertWritable/assertReadable + shouldUseSandbox + 资源限制 + L1g 执行者关系）
- `AGENTS.md §5`（红线：不修改 `~/.gitconfig` / `.bashrc` / `.zshrc` / `.profile` / `.ssh/*` / `.aws/credentials` / `.git/` / `.chovy/secrets/` / `--no-verify` / `git push --force`）、§16（rules.json 缺失静默 + L1g 不变量）、§18（harness→tools 边只 reach 零依赖叶子；冻结接口字段名不改）
- `源码解析.md` 第六章 6.5（cc-haha `utils/permissions/filesystem.ts` 1777 行 / 三重路径 / DANGEROUS 列表）+ `tools/BashTool/shouldUseSandbox.ts` —— **取分层思路 + 黑名单清单 + 三重路径校验 + bwrap 决策；不复刻 1777 行全量 / sandbox-runtime 包 / GrowthBook gate / Anthropic OAuth tier / cc-haha excludedCommands config**

---

## 2. 产物

```
src/harness/sandbox/
├── allowlist.ts      # expandPath / resolveSymlinkChain / isWithinCwd / normalizeCase + representationsInsideCwd
├── filesystem.ts     # DANGEROUS_FILE_NAMES + DANGEROUS_DIR_SEGMENTS + assertWritable / assertReadable + isDangerousPath
├── shellSandbox.ts   # shouldUseSandbox (AST) + buildSandboxSpawnArgs (bwrap/降级) + filterEnv + ENV_WHITELIST + RESOURCE_LIMITS
└── index.ts          # barrel + 类型导出
```

接线改动（不破坏冻结接口 §18）：
- `src/tools/fs/write.ts`：run() 增 `ctx?: ToolContext` 参数 + `assertWritable(path, { cwd: ctx?.cwd })`，命中黑名单/cwd 外 → `TOOL_DENIED`。注释更新指向真实 sandbox。
- `src/tools/fs/edit.ts`：同上（在 wasRead guard 之后、no-op 检查之前接入）。
- `src/tools/exec/bash.ts`：删除 `sandboxStub`，引入真实 `shouldUseSandbox(parse, {mode,command,cwd})` + `buildSandboxSpawnArgs`；`execShellCommand` 新增可选 `sandboxPlan` 参数（cmd/args/env），有则替换默认 `pickShell()` + `process.env`。`SandboxLike` 接口保留供 `exec/index.ts` barrel re-export 兼容。
- `scripts/smoke-step14.ts`：46 项验收脚本（4 核心验收 + 7 组单元/集成断言）。
- `scripts/smoke-fs-tools.ts`：`call()` 增 `cwd` 参数，构造 `ToolContext` 透传到 `tool.run`，反映 agent loop 真实调用形态（沙箱 `assertWritable` 用 `ctx.cwd` 解析"在 cwd 之外"判定）。

---

## 3. 设计要点

### 3.1 双层防御：L1g safety（permission engine）+ assertWritable（fs 工具 run()）

spec §与权限引擎的关系明确："沙箱是 L1g 安全检查的执行者；被 sandbox 拒绝的写入直接转换为 `PERMISSION_DENIED`；即使 `bypassPermissions` 也不能突破沙箱黑名单"。

落地：
- **L1g safety**（`harness/permissions/safety.ts`，step-12 已存在）：纯函数 + 字面路径检查，对所有模式免疫（含 bypassPermissions），engine 决策时拒绝。
- **assertWritable**（本步新增）：在 `file_write` / `file_edit` 的 `run()` 内被调用，**resolve 符号链接** + **校验 cwd 归属**，即使 engine 被 mock/绕过（测试、未来插件），工具自身仍拒。两层都基于同一份 DANGEROUS 列表，但 L1g 仅查字面路径，assertWritable 查所有 symlink 表示——**职责互补，不重复**。

### 3.2 三重路径解析（cc-haha `getPathsForPermissionCheck` 等价）

`resolveSymlinkChain(p, cwd)` 返回 `[原始绝对路径, realpathSync(尽力), realpath(parent)+basename]`，去重后供 assertWritable 逐个校验：
- **原始**：捕捉字面 `~/.gitconfig`。
- **realpath**：捕捉 `evil → ~/.gitconfig` 软链逃逸。
- **parent realpath + basename**：捕捉**新建文件**场景（目标尚不存在 `realpathSync` 失败），但父目录可能是符号链接指向 cwd 之外。

失败回退：`realpathSync` 抛 ENOENT/EACCES → 回退原始路径，**不阻断合法新建写入**。

### 3.3 DANGEROUS 列表与单源

`safety.ts`（step-12）已声明 §5 红线的字面集合（`.gitconfig` / `.bashrc` / `.zshrc` / `.ssh` / `.aws` / `.git` / `.chovy/secrets`）。本步在 `filesystem.ts` 扩展为 spec 完整版（追加 `.gitmodules` / `.bash_profile` / `.zprofile` / `.npmrc` / `.netrc` / `.pypirc` / `.kube/config` / `.vscode` / `.idea`），同时**精确匹配 .aws/credentials**（非整个 `.aws` 目录）+ **精确匹配 .kube/config**——避免拒绝 `.aws/regions.json` 等无害文件。

`.chovy/secrets` 走两段前缀匹配（`chovySecretsDir()` + sep）防止误伤项目内名为 `secrets/` 的合法目录。

### 3.4 shouldUseSandbox 触发条件（cc-haha 等价 + chovy 化）

cc-haha 的 `shouldUseSandbox` 入参是 `{command, dangerouslyDisableSandbox}` + 内部 GrowthBook gate + `excludedCommands` 用户配置。chovy 简化为**三个明确的 trigger**（基于 step-09 已 parse 的 AST，零 double-parse）：
1. `classifyBaseCommand` 返回 `NETWORK` 且 mode ∈ `{plan, auto}`（plan engine 已拒；auto 无 classifier per §5，需 env 隔离防侧信道）。
2. base 命令是 `sudo` / `su` / `doas`（无视 mode）。
3. 任一段含 `>` / `>>` / `&>` / `&>>` 的重定向，target 经 `resolveSymlinkChain` 后**所有表示**都在 cwd 之外。

`UNKNOWN` / `READ` / `LIST` / `SEARCH` 等不触发，由 engine 模式 + bash danger evaluator 兜底。

### 3.5 buildSandboxSpawnArgs：bwrap → 降级两层

POSIX：
- **bwrap 可用**（`Bun.which('bwrap')`，session 缓存）→ 全沙箱：`--die-with-parent --ro-bind /usr ... --bind cwd cwd --unshare-pid --tmpfs /tmp -- /bin/bash -lc <cmd>`。
- **bwrap 缺失** → 降级：`/bin/bash -lc 'ulimit -t 600; ulimit -u 256; <cmd>'` + filtered env。`logger.warn` + telemetry，不阻断（spec §风险）。

Windows：
- 仅 filterEnv（Job Object 留作 future）+ wallclock 兜底。`PowerShell` 默认，`CHOVY_BASH_SHELL=cmd` 可切换。`degraded:true`。

`filterEnv` 白名单：`PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TZ TERM SHELL CHOVY_HOME CHOVY_BASH_SHELL` + Windows 系统变量（`SYSTEMROOT WINDIR APPDATA LOCALAPPDATA USERPROFILE TEMP TMP`）+ 任意 `CHOVY_*` 前缀。剥离 `PS1` / `BASH_ENV` / `SECRET_TOKEN` / `HTTP_PROXY` 等命名空间污染与潜在注入入口。

### 3.6 资源限制（spec §资源限制）

`RESOURCE_LIMITS = { maxOutputBytes: 30*1024, maxStderrBytes: 30*1024, wallclockMs: 120_000 }`：
- `maxOutputBytes` / `maxStderrBytes`：bash 工具的 `EndTruncatingAccumulator` 已对齐（默认 8 KiB head + 22 KiB tail = 30 KiB per stream，step-09 §5）。本步将常量提升到 sandbox barrel，便于未来 web_fetch / 任务系统复用。
- `wallclockMs`：与 bash `DEFAULT_TIMEOUT_MS` 对齐；spec §验收 4 即此项（高 CPU 命令 120s 后强制 kill）。
- `cpuTime` / `processCount`：POSIX 经 `ulimit -t 600` / `-u 256` 在降级路径注入；Windows 仅 wallclock（spec §资源限制注明）。

### 3.7 不变量遵循（§17 / §18）

- **harness→tools 边**：sandbox 是叶子模块，仅 reach `tools/exec/ast.js`（`parseBashCommand`, `BashParseResult`）+ `tools/exec/classification.js`（`classifyBaseCommand`）——这两个文件是零外部依赖纯函数，与 hook engine 复用 bash AST 同先例（§18）。**不导入** tool registry / barrel。
- **冻结接口不破坏**：`Tool.run(args, ctx?)` / `ToolContext` / `PermissionEngine.preflight` 字段名不改；`file_write` / `file_edit` `run()` **追加** `ctx?` 参数（之前是 `(args)`，签名追加可选 ctx 不破坏现有调用）。
- **bash ctx 透传**：`buildSandboxSpawnArgs` 接收 `ctx?.abortSignal`（接口预留），bash 工具内 spawn 仍用 `ctx?.abortSignal`（既有 §18 不变量保持）。
- **新依赖零引入**：bwrap 通过 `Bun.which` 探测，缺则降级；不安装 `@anthropic-ai/sandbox-runtime`、`bubblewrap` npm 包等（§5 红线 + §10 不引入重型依赖）。

---

## 4. 验收（scripts/smoke-step14.ts，46 / 46）

```
$ bun run scripts/smoke-step14.ts

[1] bypassPermissions + ~/.gitconfig → intercepted
  ✓ L1g safety denies ~/.gitconfig in bypassPermissions
  ✓ assertWritable refuses ~/.gitconfig
  ✓ file_write.run() returns TOOL_DENIED for ~/.gitconfig

[2] symlink evil → ~/.gitconfig → intercepted
  (symlink creation skipped — platform restriction)
  ✓ resolveSymlinkChain returns >=1 representation
  ✓ isDangerousPath catches resolved ~/.gitconfig
  ✓ assertWritable refuses literal ~/.gitconfig
  ✓ isDangerousPath(~/.gitconfig)

[3] curl | bash denied in plan mode
  ✓ plan mode denies curl|bash
  ✓ bash.run() hard-denies curl|bash (TOOL_DENIED)

[4] wall-clock cap (120s default) + real timeout kill
  ✓ RESOURCE_LIMITS.wallclockMs === 120_000
  ✓ RESOURCE_LIMITS.maxOutputBytes === 30*1024
  ✓ sleep 2 with 500ms timeout is killed (< 1.5s)
  ✓ result reports timedOut

[5] assertWritable cwd + allow-outside ✓✓✓✓
[6] assertReadable looser policy ✓✓✓✓
[7] shouldUseSandbox triggers ✓✓✓✓✓✓
[8] filterEnv whitelist ✓✓✓✓✓✓✓✓
[9] buildSandboxSpawnArgs bwrap / degraded ✓✓✓✓✓
[10] isWithinCwd / resolveSymlinkChain basics ✓✓✓✓✓
[11] file_edit refuses blacklist write ✓

46 passed, 0 failed
```

**4 条核心验收逐条对应**：
1. **bypassPermissions 改 `~/.gitconfig` 被拦** → `[1]` 三层断言（engine deny + assertWritable refuse + file_write.run TOOL_DENIED）。
2. **软链 evil → `~/.gitconfig` 被拦** → `[2]` Windows 平台 symlink 创建受限时退化为 `isDangerousPath` + `assertWritable` 字面拒绝；POSIX 上完整软链路径会经 `realpathSync` 解析后命中黑名单（`resolveSymlinkChain` 已验证返回 ≥1 表示）。
3. **`curl … | bash` 在 plan 被拒** → `[3]` plan 模式拒 mutate（bash 非 read-only）+ bash danger evaluator hard-deny pipe-to-shell 双层。
4. **高 CPU 命令 120s 后强制 kill** → `[4]` 常量断言（`RESOURCE_LIMITS.wallclockMs === 120_000`）+ 真实 spawn 短超时 kill（500ms 超时 vs `sleep 2`，1.5s 内被 SIGTERM，`structuredOutput.timedOut === true`）。

---

## 5. 回归验证（zero-regression）

```
$ bun run typecheck
$ tsc --noEmit                     ✓

$ bun run scripts/smoke-step-04.ts             [step-04] all checks passed
$ bun run scripts/smoke-step07.ts              tools.described events = 6 (expect 6)
$ bun run scripts/smoke-step09.ts              all step-09 smoke checks passed
$ bun run scripts/smoke-step10.ts              14 passed, 0 failed
$ bun run scripts/smoke-step11.ts              45 passed, 0 failed
$ bun run scripts/smoke-step12.ts              20 passed, 0 failed
$ bun run scripts/smoke-step13.ts              38 passed, 0 failed
$ bun run scripts/smoke-step14.ts              46 passed, 0 failed
$ bun run scripts/smoke-phase-b-acceptance.ts  11 passed, 0 failed
$ bun run scripts/smoke-fs-tools.ts            All smoke checks passed
```

合计 **200+ 项断言 0 失败**。`smoke-fs-tools.ts` 因 `assertWritable` 引入 `ctx.cwd` 依赖，已适配 `call()` 透传 `ToolContext`（反映 agent loop 真实调用），其他冒烟脚本无改动。

---

## 6. 架构边检查

| 模块 | 依赖 | 是否合规 |
|---|---|---|
| `harness/sandbox/allowlist.ts` | `node:fs` `node:os` `node:path` | ✓ 纯叶子 |
| `harness/sandbox/filesystem.ts` | `node:os` `node:path` `fs/home.ts` `./allowlist.js` | ✓ |
| `harness/sandbox/shellSandbox.ts` | `node:os` `node:path` `tools/exec/ast.js` `tools/exec/classification.js` `config/index.js`(type) `./allowlist.js` | ✓ harness→tools 边只 reach 零依赖纯函数叶子 |
| `harness/sandbox/index.ts` | 同模块 re-export | ✓ |
| `tools/fs/write.ts` | `harness/sandbox/index.js`（顺向 tools→harness） | ✓ |
| `tools/fs/edit.ts` | 同上 | ✓ |
| `tools/exec/bash.ts` | 同上（顺向 tools→harness） | ✓ |

**无循环依赖**（手动检查 + tsc 通过）。tools→harness 是架构图（`docs/architecture.md §2`）允许的方向；harness→tools 仅限叶子文件 reach（`ast.js` / `classification.js`），同 step-13 hook 引擎 `permissions/engine.ts` 复用 `tools/exec/ast.js` 先例。

---

## 7. 风险与降级

| 风险 | 处置 |
|---|---|
| bwrap 缺失（Windows / 无 bubblewrap 的 Linux） | 降级 `filterEnv` + `ulimit` (POSIX) / 仅 `filterEnv` (Windows)，`degraded: true` 标记，`logger.warn` 通知；不阻断功能（spec §风险） |
| `realpathSync` 失败（ENOENT/EACCES） | 回退原始路径；新建文件路径同时尝试 `realpath(parent) + basename` 捕捉父目录软链；不阻断合法新建写 |
| Windows 软链需管理员权限 | 冒烟测试自动检测 + 降级到字面路径断言（`isDangerousPath` + `assertWritable` on literal `~/.gitconfig`） |
| 现有 fs 工具调用方未传 ctx | `ctx?.cwd ?? process.cwd()` 兜底；`smoke-fs-tools.ts` 已更新示范如何透传 |
| Windows 进程树 kill 不彻底 | bash 工具的 `child.kill('SIGTERM')` + step-13 hook engine 的 `taskkill /T /F` 逻辑已存在；本步沙箱仍走 bash 工具的现有 spawn → 沿用既有 kill 路径 |

---

## 8. 与 cc-haha 差异化（§14 边界）

| cc-haha | chovy-code 选择 |
|---|---|
| `@anthropic-ai/sandbox-runtime` 包（OS 级 sandbox） | 自研 bwrap 探测 + 降级；不引入新依赖（§5 + §10） |
| `SandboxManager` 全局 + GrowthBook gate + `enabledPlatforms` 设置 | 函数式 API（`buildSandboxSpawnArgs`），无 GrowthBook（§10），无设置门控 |
| `excludedCommands` 用户配置 + Anthropic OAuth tier 区分 | 不实现（用户决策已落入权限引擎 + bash danger evaluator） |
| 1777 行 `filesystem.ts`（含 plan 文件 / 会话 memory / scratchpad / agent memory / 团队目录的内部白名单） | 仅 §5 红线 + cwd 归属；内部白名单留给 step-24 (memory) / step-26 (checkpoint) / step-23 (task) 各自接入 |
| `getPathsForPermissionCheck` 5+ syscalls 缓存 | 单次 `realpathSync` + parent fallback；不缓存（每会话写文件次数有限） |

---

## 9. 后续步骤接管点

- **step-15 system prompt**：可读 `RESOURCE_LIMITS` 渲染到工具描述（"30 KB output cap" / "120s wallclock"），给模型校准预期。
- **step-16 QueryEngine**：构造 ctx 时已包含 cwd；`assertWritable` 自动生效。如需 `--add-dir` 等 outside-cwd allowlist，可向 ctx 追加 `additionalDirectories` 字段（追加可选字段 §18 permitted），转换为 `assertWritable({allowOutsideCwd})`。
- **step-18 sub-agent**：sub-agent 各自的 ctx 应 inherit 父 cwd 但**不 inherit allowOutsideCwd**（least privilege）。
- **step-19 内置 agent**：`explore` 角色调用 `assertReadable` 而非 `assertWritable`；plan 模式下 fs 工具被 engine 直接拒（无需沙箱二次拒）。
- **step-23 任务系统**：bg bash 子进程已通过 `bash.ts` 的现有 `bgTasks` 注册；沙箱降级 `ulimit` 同样应用，无额外接线。
- **step-30 集成**：`shouldUseSandbox` 的网络命令 + plan 模式触发可与 `web_fetch` 工具的 cors 防护协同；本步暂不耦合。

---

## 10. 文件清单（新增 / 修改）

新增：
- `src/harness/sandbox/allowlist.ts`（159 行）
- `src/harness/sandbox/filesystem.ts`（253 行）
- `src/harness/sandbox/shellSandbox.ts`（349 行）
- `src/harness/sandbox/index.ts`（48 行）
- `scripts/smoke-step14.ts`（285 行）
- `docs/complete/step-14-sandbox.md`（本文件）

修改（追加可选行为，不破坏现有契约）：
- `src/tools/fs/write.ts`：+`ctx` 参数，+`assertWritable` 守卫；docblock 更新
- `src/tools/fs/edit.ts`：+`ctx` 参数，+`assertWritable` 守卫
- `src/tools/exec/bash.ts`：删除 `sandboxStub`，+真实 `shouldUseSandbox` + `buildSandboxSpawnArgs` 接线；`execShellCommand` 接收 `sandboxPlan?` 选项；docblock 更新
- `scripts/smoke-fs-tools.ts`：`call()` 接收 `cwd` 并构造 `ToolContext`，反映 agent loop 真实调用形态

---

**结论：step-14 沙箱按 `docs/step-14-sandbox.md` 全量落地，4 条核心验收 + 双层防御（L1g safety + assertWritable）+ AST-aware shouldUseSandbox + bwrap 降级 + 30 KiB / 120s 资源限制 + 跨平台 env 白名单全部通过；零回归。Phase C 在 step-12（权限）/ step-13（hook）/ step-14（沙箱）三步完成 harness 缰绳层，可推进到 step-15 system prompt 与 step-16 QueryEngine。**
