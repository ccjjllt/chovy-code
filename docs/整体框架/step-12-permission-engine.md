# Step 12 — Permission Engine（6 层决策 + 5 模式）

**Phase**: C | **依赖**: 06 | **可并行**: ❌（需被 13/14 顺序构建） | **估时**: 6h

## 目标

实现 chovy-code 的 **缰绳层核心**：6 层权限决策引擎与 5 种权限模式。
本步**不做**钩子（步骤 13）与沙箱（步骤 14）的实质实现，但为它们留好接口。

## 产物

```
src/harness/permissions/
├── engine.ts            # hasPermission(tool, args, ctx)
├── modes.ts             # 5 种 PermissionMode + 切换 API
├── rules.ts             # 用户/项目级 ask/allow/deny 规则
├── denialTracking.ts    # 拒绝熔断器（46 行级别的小模块）
└── index.ts
```

## 5 种模式

```ts
export type PermissionMode =
  | 'default'            // 每次问；安全默认
  | 'plan'               // 只读；任何 mutate/exec 直拒
  | 'acceptEdits'        // 文件编辑自动通过；其他仍问
  | 'auto'               // 启发式 + 白名单自动判断（无小模型也能跑）
  | 'bypassPermissions'; // 几乎全部放行（仍受沙箱与硬黑名单约束）

export type PermissionOutcome = 'allow' | 'ask' | 'deny';
```

`auto` 模式中，**不**强依赖小模型分类器（chovy-code 默认无 YOLO 模型，避免每次额外调用）；
而是用：白名单 + 命令分类（步骤 09 的 SEARCH/READ/LIST 自动 allow）+ 对未识别工具回退到 `ask`。

> 可选：若 `feature('auto.classifier')` 开启，调用一个轻量小模型（`gpt-4o-mini` 等）做风险评估。

## 6 层决策（伪码）

```
function hasPermission(tool, args, ctx) {
  // L1 工具级规则
  L1a: if denyRule(tool) → DENY
  L1b: if askRule(tool, args) → askResult
  L1c: const pre = await tool.checkPermissions?.(args, ctx)
       if pre?.outcome === 'deny' → DENY
       if pre?.outcome === 'ask'  → ask = true
  // L1d/g：内容特定 deny / 安全检查
  L1g: const safety = await safetyCheck(tool, args, ctx)  // 危险模式
       if safety === 'deny' → DENY  // 对所有模式免疫

  // L2 模式过滤
  if mode === 'bypassPermissions' → ALLOW (但 safety deny 已生效)
  if allowListMatch(tool, args) → ALLOW

  // L3 模式转换：在 dontAsk 上下文（后台 agent）将 ask → deny
  if ctx.dontAsk && current === 'ask' → DENY

  // L4 自动模式
  if mode === 'acceptEdits' && tool.family === 'fs.mutate' → ALLOW
  if mode === 'auto':
     if SAFE_TOOLS.has(tool.name) → ALLOW
     if isBashSafe(args) → ALLOW
     else → ask

  // L5 用户钩子（step-13）
  const hookOutcome = await hooks.run('PermissionRequest', {tool, args})
  if hookOutcome === 'allow' / 'deny' → return that

  // L6 用户交互
  const ui = await askUser(tool, args)
  if ui === 'denied' → recordDenial; return DENY
  return ALLOW
}
```

## 安全检查（L1g）硬约束

对所有模式（含 `bypassPermissions`）都生效：

- 修改 `~/.gitconfig` / `~/.bashrc` / `~/.zshrc` / `~/.profile` / `~/.ssh/*`：deny；
- 修改项目 `.git/`：deny；
- 修改 `.chovy/secrets/`：deny；
- 任何 git 命令含 `--no-verify`：deny；
- `git push --force` / `--force-with-lease`：ask（不直接 deny，因常用）。

## 拒绝熔断器（denialTracking）

参考 cc-haha 的 46 行设计：

```ts
export const DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 } as const;
export interface DenialState { consecutiveDenials: number; totalDenials: number; }
export function recordDenial(s: DenialState): DenialState;
export function recordSuccess(s: DenialState): DenialState; // 仅重置 consecutive
export function shouldFallbackToPrompting(s: DenialState): boolean;
```

`auto` 模式下，达到熔断条件后强制降级为 `default`（剩余会话）。

## 规则文件

`~/.chovy/rules.json` 与项目 `.chovy/rules.json`：

```json
{
  "allow": ["Glob", "Grep", "Read", "Bash(npm test:*)"],
  "ask":   ["Bash(git push:*)"],
  "deny":  ["Bash(rm -rf:*)"]
}
```

匹配语法：`Tool` 全工具；`Tool(prefix:*)` 内容前缀；可写 regex。

## 验收标准

- 默认模式下 Read/Grep/Glob 直接通过，Edit 触发 ask，rm -rf 直接 deny；
- plan 模式下任何 mutate 工具拒绝；
- `bypassPermissions` 模式下 .gitconfig 修改仍被拒；
- 连续 3 次 ask 拒绝后 auto 模式自动降级为 default。

## 参考源

- `cc-haha/src/utils/permissions/permissions.ts`、`yoloClassifier.ts`、`denialTracking.ts`、`filesystem.ts`

## 风险

- L1 与 L4 顺序错乱 → 单测覆盖：plan 模式下 acceptEdits 不应改写它的判定。
