# Step 13 — Hook Engine（8 类事件 + 竞速机制）

**Phase**: C | **依赖**: 12 | **可并行**: ❌ | **估时**: 5h

## 目标

实现可编程的 AI 控制权——用户/项目可在 8 个关键时刻插入命令或函数钩子，**包括竞速机制**：
权限决策与钩子可并行，谁先返回结果谁赢。

## 产物

```
src/harness/hooks/
├── engine.ts          # 主调度
├── snapshot.ts        # 启动时一次性快照（防热改注入）
├── settings.ts        # 钩子配置加载
├── runners.ts         # command runner / function runner
└── index.ts
```

## 事件清单

```ts
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'GoalIteration'        // chovy-code 新增
  | 'SubAgentSpawn'        // chovy-code 新增
  | 'CheckpointWritten';   // chovy-code 新增
```

## 配置（settings.json）

```json
{
  "hooks": [
    { "event": "PreToolUse", "matcher": "Bash(*rm*)", "type": "command",
      "command": "echo '⚠️ rm detected' >&2", "timeoutMs": 1000 },
    { "event": "PostToolUse", "matcher": "FileEditTool", "type": "command",
      "command": "biome check --write" },
    { "event": "GoalIteration", "matcher": "*", "type": "command",
      "command": "bun typecheck" }
  ]
}
```

`type` 支持：`command`（spawn）、`function`（动态加载 ESM 文件 default export）。

## 返回值规约

钩子 stdout 应输出 JSON：

```ts
type HookResult = { ok: true } | { ok: false; reason: string } | undefined;
```

- `{ok:true}` → 放行 / 无意见；
- `{ok:false, reason}` → 拦截（reason 给到模型 / UI）；
- 无 stdout / 超时 → 旁路（视为无意见）。

退出码 0 必需；非 0 视为旁路 + telemetry warn。

## 竞速机制

权限决策的 L5/L6 与钩子 PermissionRequest 并行：

```
const winner = await Promise.race([
  userPrompt(),                       // 用户对话框
  hook.run('PermissionRequest', ...), // 钩子
  classifier?.run(),                  // auto 模式分类器（可选）
]);
```

第一个 `decisive`（allow/deny）的胜出；其他取消。
（`{ok:true}` 不视为 decisive；只有 deny 或显式 allow 才决策成功。）

## 启动快照

`snapshot.ts` 在 SessionStart 时把当时的 `settings.json` 复制为 in-memory 副本；后续 hot-reload **仅更新文件**，
但本会话仍按快照执行。这避免了对话中改 settings 立刻生效的安全隐患。
（参考 cc-haha hooksConfigSnapshot 思路）

## Trust 边界

未信任工作区只允许 *managed hooks*（即 chovy 内置）。`shouldAllowManagedHooksOnly()` 由项目信任状态决定。
Trust 状态文件：`~/.chovy/trust.json`，记录 cwd → trusted bool。

## 验收标准

- PreToolUse 钩子 stderr 输出会出现在 UI；
- PermissionRequest 钩子 0.1s 返回 deny → 用户对话框被取消；
- PostToolUse 钩子失败 ≠ 工具失败（记录 telemetry）；
- 未信任工作区拒绝执行用户写的钩子。

## 参考源

- `cc-haha/src/utils/hooks.ts`、`utils/hooks/`

## 风险

- 钩子超时引发 UX 卡顿 → 默认 timeoutMs=2000；硬上限 10s。
