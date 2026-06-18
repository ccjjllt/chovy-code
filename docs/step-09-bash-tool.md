# Step 09 — Bash Tool（含 AST 安全解析）

**Phase**: B | **依赖**: 06 | **可并行**: ✅ | **估时**: 8h

## 目标

实现 chovy-code 最复杂的工具：跨平台命令执行 + AST 解析 + 危险模式拦截 + 沙箱钩子。

## 产物

```
src/tools/exec/
├── bash.ts             # 主入口
├── ast.ts              # AST 解析（基于 mvdan/sh 思路；本项目用轻量自研）
├── classification.ts   # 命令分类（搜索/读取/写入/网络...）
├── outputAccumulator.ts# 大输出截断
└── index.ts
```

## 核心规范

```ts
schema: z.object({
  command: z.string().describe('Single shell command. Multi-step: use && or ;'),
  description: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().min(1000).max(600_000).default(120_000),
  runInBackground: z.boolean().optional(),
});
```

## 实现要点

### 1. AST 解析

提取：
- 命令链（管道 / 逻辑链）
- 命令名 + 参数
- 重定向（>、>>、<）
- heredoc
- 反引号 / 子 shell
- 环境变量赋值

只做"结构识别"——不真正运行。失败时回退到正则启发式（保守判定为高风险）。

### 2. 分类（用于 ATP 与权限）

```ts
const SEARCH = ['find','grep','rg','ag','ack','locate','which','whereis'];
const READ   = ['cat','head','tail','less','more','wc','stat','file','jq','awk','cut','sort','uniq','tr'];
const LIST   = ['ls','tree','du'];
const SILENT = ['mv','cp','rm','mkdir','rmdir','chmod','chown','chgrp','touch','ln','cd','export','unset','wait'];
const NETWORK= ['curl','wget','ssh','scp','ftp','rsync','npm','pip','bun','yarn','pnpm'];
```

### 3. 危险模式拦截（在 checkPermissions）

```
- rm -rf /  /  rm -rf $HOME / rm -rf .
- git push --force / -f （除非 ask 规则匹配）
- chmod -R 777
- :(){ :|:& };:    # fork bomb
- curl ... | sh
- 无引号变量 + 通配符 + rm
```

### 4. 跨平台

- `process.platform === 'win32'`：默认 PowerShell；提供 `--shell cmd` 切换；
- macOS / Linux：`/bin/bash -lc`；
- 将 `$HOME`、`~` 显式展开。

### 5. 输出处理

- `EndTruncatingAccumulator`：保留首 N 行 + 末 M 行 + 中间 `... [truncated K bytes] ...`；
- 默认 stdout/stderr 各上限 30 KB；
- 超过 `ASSISTANT_BLOCKING_BUDGET_MS=15s` 自动转后台并返回"已转后台，handle=...."；
- 后台任务管理在 step-23 的 task system 中正式落地；本步只负责 spawn + handle id。

### 6. 沙箱钩子

调用 `sandbox.shouldUseSandbox(command)` 决定是否在受限子进程下执行（步骤 14 提供）。

### 7. Hint 解析

扫描 stdout/stderr 中的 `<chovy-hint version="1" type="..." ... />` 自闭合标签，剥离后保存到会话 hint 槽（单槽，参考 cc-haha claudeCodeHints.ts 设计）。**只把剥离后的输出**返回给模型。

## ATP 描述

```ts
desc: {
  lean: 'Run a shell command. Use absolute paths. Avoid destructive ops.',
  full: `Executes a shell command...
- Working directory persists between calls (use absolute paths).
- timeout is in ms (default 120s, max 600s).
- run_in_background: true detaches; you'll be notified on exit.
- Avoid: find/grep/cat/head/tail/sed/awk -- prefer dedicated tools.
- NEVER: git config edits, force push, rm -rf without confirmation.
...`,
}
```

## 验收标准

- 对 `rm -rf /` 直接 deny 而非 ask；
- 对 `git push origin main` 在 default 模式下 ask；
- Windows 上 `bun --version` 正常返回；
- 60 秒以上的 long-running 命令转后台并返回 handle。

## 参考源

- `cc-haha/src/tools/BashTool/`（特别 `bashPermissions.ts`、`shouldUseSandbox.ts`）

## 风险

- AST 误判 → 无法解析时保守标记为高风险（ask 而非 allow）。
- Windows shell 差异 → 用 `process.env.ComSpec`；提供 verbose 日志。
