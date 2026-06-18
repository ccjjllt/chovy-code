# Step 04 — FS Abstraction & Chovy Home

**Phase**: A | **依赖**: 无 | **可并行**: ✅ | **估时**: 2h

## 目标

提供跨平台（Windows / macOS / Linux）的 FS 工具与 chovy 主目录管理，并在初始化时自动创建必需的子目录。
**不**直接暴露 `node:fs` 给上层模块——所有读写一律走 `safeFs.ts`。

## 产物

```
src/fs/
├── home.ts        # ~/.chovy 路径管理
├── paths.ts       # 项目相关路径（projects/<hash(cwd)>）
├── safeFs.ts      # 包装 read/write/atomicWrite/append/exists/mkdirp
└── index.ts
```

## 实现要点

### 1. 主目录布局

```ts
// src/fs/home.ts
export function chovyHome(): string {
  // Windows: %APPDATA%/chovy   else: ~/.chovy
  // 可被 CHOVY_HOME 环境变量覆盖
}

export function ensureHomeDirs(): void {
  // 创建：config / secrets / features.json / projects / telemetry
}
```

### 2. 项目路径

```ts
// src/fs/paths.ts
export function projectId(cwd: string): string {
  // sha1(cwd).slice(0,12)
}
export function projectDir(cwd: string): string { /* chovyHome/projects/<id> */ }
export function memoryFile(cwd: string): string { /* projectDir/MEMORY.md */ }
export function notesFile(cwd: string): string { /* projectDir/notes.md */ }
export function checkpointDir(cwd: string): string { /* projectDir/checkpoints */ }
export function tasksDir(cwd: string): string { /* projectDir/tasks */ }
export function memoryDb(cwd: string): string { /* projectDir/memory.db */ }
export function sessionFile(cwd: string, id: string): string { ... }
```

### 3. safeFs

封装常用操作 + 统一错误（抛 `ChovyError('MEMORY_IO', ...)`）：

```ts
export const safeFs = {
  read(p: string): Promise<string>;
  write(p: string, content: string): Promise<void>;        // 原子写
  append(p: string, content: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  list(p: string, opts?: { recursive?: boolean }): Promise<string[]>;
  stat(p: string): Promise<{ size: number; mtime: number } | null>;
  remove(p: string): Promise<void>;                        // 仅限项目目录内（带断言）
};

export const safeFsSync = {
  read(p: string): string;                                  // 启动期 config/features/secrets 专用
};
```

原子写实现：先写 `.tmp` 同目录文件，再 `rename`。

### 4. 启动钩子

`bin/chovy.js` 启动 / `cli/index.tsx` 入口处调用 `ensureHomeDirs()` 与 `ensureProjectDirs(cwd)`。

## 验收标准

- 全平台 `~/.chovy/projects/<hash>` 自动建立；
- 写入 50 KB 文件耗时 < 30ms；
- `CHOVY_HOME=/tmp/x chovy "hi"` 生效；
- 任何 `safeFs.remove` 越界（项目目录之外）都抛错。

## 参考源

- `cc-haha/src/utils/sessionStorage.ts`、`cc-haha/src/utils/fsOperations.ts`

## 风险

- Windows 路径大小写 / 反斜杠 → 全部用 `node:path` 的 `posix`/`win32` 精确分支或 `path.join`。
- 多进程并发写 → 原子 rename 已足够；竞争记录在 telemetry。

## 验收追补（2026-06-18）

- 启动期同步读取统一通过 `safeFsSync.read()` 暴露，供 config/features/secrets 在 Ink 渲染前完成读取；其他应用 I/O 仍优先使用异步 `safeFs`。
- `src/telemetry/localSink.ts` 的 `beforeExit/exit` 同步 flush 是唯一已知白名单例外，原因是进程退出钩子不能可靠 await async I/O。
