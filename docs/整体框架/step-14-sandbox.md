# Step 14 — Sandbox（FS allowlist + 危险文件 + 命令隔离）

**Phase**: C | **依赖**: 12 | **可并行**: ❌ | **估时**: 5h

## 目标

落实文件系统沙箱与子进程隔离，确保即使在 `bypassPermissions` 模式下，
某些操作（核心配置、git 内部、密钥目录）也无法被改动。

## 产物

```
src/harness/sandbox/
├── filesystem.ts       # path 校验 + 危险目录列表
├── shellSandbox.ts     # 子进程隔离（env / cwd / 限速）
├── allowlist.ts        # 三重路径解析（原始 / 软链 / 工作目录）
└── index.ts
```

## 危险文件 / 目录（硬黑名单，不可修改）

```ts
export const DANGEROUS_FILES = [
  '~/.gitconfig', '~/.bashrc', '~/.zshrc', '~/.profile',
  '~/.ssh/**', '~/.aws/credentials', '~/.kube/config',
  '~/.npmrc', '~/.pypirc', '~/.netrc',
];

export const DANGEROUS_DIRS = [
  '.git', '.chovy/secrets', '.vscode', '.idea',
];
```

写操作经过 `assertWritable(path)`：

1. 解析为绝对路径；
2. 跟随 symlink（防"软链逃逸"）；
3. 在 cwd 之外要求 explicit allow；
4. 命中黑名单 → 抛 `ChovyError('PERMISSION_DENIED')`。

读操作经过 `assertReadable(path)`：宽松（默认 home 与 cwd 允许；其他 ask）。

## Shell 沙箱

`shouldUseSandbox(commandAst)` 决定是否在受限子进程下执行：

```ts
export function shouldUseSandbox(ast: BashAst): boolean {
  // 触发条件：
  // - 含网络命令（curl/wget）但 user 处于 plan/auto；
  // - 含 sudo / su；
  // - 写到 cwd 之外。
}
```

实现：
- Linux/macOS：用 `bwrap`（如有）或退化为"严格 env + 限制 cwd"的子进程；
- Windows：仅 env 限制（Job Object 留作 future）；
- Bun spawn 设置：
  ```ts
  Bun.spawn(cmd, { cwd, env: filteredEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: ms });
  ```
- 默认 env 白名单：`PATH HOME USER LANG TZ`。

## 资源限制

- `maxOutputBytes`: 30 KB stdout + 30 KB stderr；超出截断；
- `wallclock`: 默认 120s（与 BashTool 一致）；
- `cpuTime`: ulimit -t（POSIX）；Windows 用 wallclock 兜底；
- `processCount`: 限制 fork bomb（POSIX 用 ulimit -u；Windows 留警告）。

## 与权限引擎的关系

- 沙箱是 **L1g 安全检查的执行者**：被 sandbox 拒绝的写入直接转换为 `PERMISSION_DENIED`；
- 权限引擎只决定 ask/allow，沙箱决定 *物理上能不能做*。
- 即使 `bypassPermissions` 也不能突破沙箱黑名单。

## 验收标准

- `chovy --mode bypassPermissions` 修改 `~/.gitconfig` 被沙箱拦截；
- 软链 `evil → ~/.gitconfig` 通过软链解析后被拦截；
- `curl ... | bash` 在 plan 模式被拒；
- 高 CPU 命令在 120s 后强制 kill。

## 参考源

- `cc-haha/src/utils/permissions/filesystem.ts`、`tools/BashTool/shouldUseSandbox.ts`

## 风险

- bwrap 缺失导致沙箱降级 → 启动 telemetry warn；不阻断功能。
- Windows 进程树 kill 不彻底 → 用 `taskkill /T /F`。
