# AGENTS.md

> 这是面向 **编码型 AI 智能体（agents）** 的仓库级指南。它告诉你：仓库目前在哪里、要去哪里、必须遵守的规则、推荐的工作流、以及如何避免踩坑。

## 1. 项目一句话

`chovy-code` 是一个用 **Bun + TypeScript + React/Ink** 构建的多 provider 编码代理 CLI。
它不仅具备基础对话与工具调用能力，还实现了 5 项核心差异化创新（ATP / SwarmR / TMT / SCW / CSG）。
**当前阶段：优化修复阶段 (Optimization and Fix Phase)。** 所有基础功能和 TUI 组件已通过验收，现在的核心任务是提升稳定性、修复已知 bug、进行必要的性能优化和代码重构。

## 2. 优化修复阶段的行为规范

作为 AI 智能体，在进行优化或修复时，请遵循以下核心规范：

1. **精准定位与重构**：
   - 优先通过 `grep_search`、日志错误信息、或阅读代码定位问题。
   - **必要时可以进行大规模重构**，只要这能显著提升代码质量、解决深层次架构问题或性能瓶颈。
2. **测试驱动的保障**：
   - **强制要求：每次更新优化后，都要进行测试文件的检查，看看是否过时。**
   - 如果测试脚本过时（例如 CLI 签名已变），必须同步更新测试脚本（如 `scripts/smoke.ts`），确保 `bun run typecheck` 和 `bun run smoke` 能正确拦截 bug，而非因为测试过时导致“假绿”或“假红”。
3. **分层调试**：
   - 确定 bug 边界：UI 问题看 `src/cli/components/`，引擎逻辑看 `src/engine/`，多代理分发看 `src/swarm/`，工具调用看 `src/tools/`。

## 3. 必须遵守的硬规则 (Hard Rules)

> 这些规则对所有 agent 生效。

1. **不修改 `~/.gitconfig`、`.bashrc`、`.zshrc`、`.profile`、`~/.ssh/*`、`~/.aws/credentials`、`.npmrc`、`.netrc`**。
2. **不修改项目内 `.git/`、`.chovy/secrets/`、`.vscode/`、`.idea/`**。
3. **不在 git 命令上加 `--no-verify`**，除非用户明确要求。
4. **不 `git push --force` / `--force-with-lease`**，除非用户明确要求。
5. **不 `rm -rf`** 任何超出当前 cwd 的路径；项目内也要二次确认。
6. **不上传任何代码 / secrets / 日志到外部服务**，包括 pastebin、issue tracker 等。

## 4. 源码参考模块映射表

当用户说“参考 mimocode”或“参考 cc-haha”时，你需要分析它们对应的源码，并快速找到相关文件。以下是核心参考代码库的**详尽模块映射**，便于快速检索、横向比对和移植参考：

### 4.1 Chovy-Code 自身模块结构 (当前项目)
- `src/cli/`：TUI 界面组件（基于 React/Ink）、命令行解析、全局配置向导（`config/`）。
- `src/cli/components/`：界面展示，如 `AgentRepl.tsx`、虚拟列表、状态栏等。
- `src/engine/`：QueryEngine 核心逻辑，含 Token Cost 跟踪、Stream 解析、System Prompt 组装。
- `src/swarm/`：SwarmR 多智能体并发与调度系统，含并发限制器、Router 和 Judge 判定逻辑。
- `src/tools/`：工具底层实现（ATP，自适应 Token 预算），包含 `fs`, `exec`, `web` 等子模块。
- `src/memory/`：TMT (Tag-based Memory Tree) 存储，依赖 Bun:SQLite FTS全文检索引擎。
- `src/harness/`：沙箱、权限控制与 Hooks 拦截机制。
- `src/providers/`：各家大模型 API 的调用适配（OpenAI, Anthropic, Gemini, DeepSeek, Zhipu 等）。

### 4.2 cc-haha (`D:\Desktop\cc-haha-main`) 模块详尽映射
*特点：高度复杂的大型单体 TypeScript + React/Ink 客户端，极具参考价值的 TUI 交互。*
- **核心逻辑层**：
  - `src/main.tsx`：巨型的主干入口逻辑和状态挂载点。
  - `src/query.ts` / `src/QueryEngine.ts`：请求发送、工具执行分配、大模型流处理。
  - `src/tools/` & `src/tools.ts`：文件编辑、执行命令、网页搜索等系统底层能力的定义与执行。
- **UI/TUI 组件层 (`src/components/`)**：
  - 拥有 100+ 个高度细分的组件。
  - 对话流渲染：`VirtualMessageList.tsx`, `MessageRow.tsx`, `Message.tsx`, `Messages.tsx`。
  - 交互界面：`SearchBox.tsx`, `HistorySearchDialog.tsx`, `GlobalSearchDialog.tsx`, `QuickOpenDialog.tsx`。
  - 特殊组件状态：`ToolUseLoader.tsx`, `FallbackToolUseErrorMessage.tsx`, `TokenWarning.tsx`。
- **高级系统集成层**：
  - `src/mcp/`：MCP (Model Context Protocol) 服务端接入和协议交互。
  - `src/daemon/` / `src/server/`：后台常驻进程/服务端守护逻辑。
  - `src/memdir/` / `src/history.ts` / `src/memory/`：项目级别的记忆存储和多会话上下文持久化。
  - `src/sandbox/` & `src/permissions/`：指令拦截、沙箱隔离验证及危险行为提示。

### 4.3 MiMo-Code (`D:\Desktop\MiMo-Code-main`) 模块详尽映射
*特点：基于 Monorepo 架构的工业级产品级代码。支持多端（Electron 桌面端、Web 控制台、VSCode 插件等）。包含底层 Engine 的解耦封装。*
- **核心业务引擎 (`packages/opencode/src/`)**：
  - `agent/`：不同形态代理的实现。
  - `command/` / `cli/`：命令行处理层。
  - `mcp/` / `lsp/`：协议层，集成 Model Context Protocol 和语言服务器。
  - `permission/`：细粒度的权限体系控制。
  - `session/` / `workflow/`：用户会话与自动化流。
  - `auth/` / `account/`：登录体系验证机制。
- **桌面端容器 (`packages/desktop/src/`)**：典型的 Electron 标准分层。
  - `main/`：Electron 主进程（系统原生 API 桥接、进程管理）。
  - `renderer/`：React 渲染进程（UI 交互与视图展示）。
  - `preload/`：安全跨域桥接隔离层。
- **其他独立生态 (`packages/`)**：
  - `app/`：可能作为 Web 端统一入口或 PWA 容器。
  - `extensions/` / `plugin/`：对 VSCode 插件或其他扩展系统的集成。
  - `console/`：独立的终端 Web 管理后台或日志审计面。
  - `shared/` / `sdk/`：被多端复用的基础工具类、类型定义及可第三方引入的 SDK。
