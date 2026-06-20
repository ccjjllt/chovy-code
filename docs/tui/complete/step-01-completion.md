# Step 01 完成报告 — Types & Unified Error Model

> 关联文档：[`../step-01-types-and-error-model.md`](../step-01-types-and-error-model.md)
> 完成时间：2026-06-18
> Phase：A（Foundation） · 依赖：无 · 实际耗时：约 1h

---

## 1. 关联

- **step**：`docs/step-01-types-and-error-model.md`
- **innovations**：为 ATP / SwarmR / TMT / SCW / CSG 全部预埋类型锚点（不实现功能，仅冻结接口骨架）
- **屏障**：本步是 Phase A 的"类型基线"；后续 step-06（Tool v2）、step-17（Provider 真实接线）、step-18（SubAgent runtime）、step-24（Memory store）、step-27（Context monitor）、step-29（Skill graph）会在此之上**收紧 / 替换**草案类型

---

## 2. 改了什么

### 2.1 新增文件（7 个）

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `src/types/errors.ts` | `ErrorCode`（20 项联合）、`ChovyError` 类、`isChovyError`、`formatChovyError` | 唯一的运行时模块；产出 `chovy.error: <CODE> <message>` 给 step-03 logger 识别 |
| `src/types/agent.ts` | `AgentRole`、`AgentLifecycle`、`SubAgentHandle`、`BuiltInAgentDefinition` | 子 Agent 生命周期 + 内置角色定义草案，frozen at step-18/19 |
| `src/types/memory.ts` | `MemoryLayer`（4 类）、`MemoryKind`、`MemoryRecord`、`MemoryQuery` | TMT 4 层记忆 schema 草案，frozen at step-24/25 |
| `src/types/goal.ts` | `GoalPhase`、`GoalState`、`ConvergenceCriteria` | `/goal` 长程任务状态机草案，frozen at step-23 |
| `src/types/skill.ts` | `Skill`、`SkillNode` | CSG 技能图节点草案，frozen at step-29 |
| `src/types/hook.ts` | `HookEvent`（8 种）、`HookOutcome`、`HookContext`、`HookHandler` | 8 类钩子事件草案，frozen at step-13 |
| `src/types/context.ts` | `ContextBudget`、`ContextSnapshot` | SCW 预算化注入 / 阈值快照草案，frozen at step-27/28 |

### 2.2 增量改动（3 个既有文件，**只新增不修改既有签名**）

- **`src/types/messages.ts`**
  - `ChatMessage` 新增可选字段：`id?: string`、`ts?: number`、`reasoning?: string`、`annotations?: Array<{type, payload}>`
- **`src/types/provider.ts`**
  - 新增 `ProviderCapabilities` 接口（`streaming / tools / vision / jsonMode / promptCache / longContext / contextWindow`）
  - `ProviderInfo` 新增可选 `capabilities?: ProviderCapabilities`（step-17 升级为必填）
- **`src/types/tool.ts`**
  - 新增类型：`ToolFamily`、`ToolDescriptions`、`ToolPermissionDecision`、`ToolContextDraft`、`ToolResultDraft`
  - `Tool<T>` 新增可选字段：`descriptions?`、`family?`、`checkPermissions?`（step-06/12 升级为必填）

### 2.3 Barrel

- 更新 `src/types/index.ts`：将 7 个新文件接入 `export *`

---

## 3. 偏离 step 文档之处

> step 文档示例使用了构造函数参数属性 (`public readonly code: ErrorCode`)，
> 但项目 `tsconfig.json` 启用了 **`erasableSyntaxOnly: true`**——参数属性属于不可擦除语法，会编译失败。

- **`ChovyError`**：改为显式字段声明 + 构造体内赋值，语义保持一致；
  - `code` / `meta` 仍然 `readonly`；
  - `cause` 通过 `super(message, { cause })` 走 ES2022 `Error` 原型继承，不重复声明，避免与 lib 类型冲突。
- **错误码集合**：未使用 `enum`（同样因 `erasableSyntaxOnly`），改为字符串字面量联合 `ErrorCode`。运行时无 footprint，更适合跨 worker 并行使用。
- **跨域守卫**：`isChovyError` 用 `e.name === 'ChovyError'` 做判定，避免跨 realm（worker / IPC）`instanceof` 失效。

---

## 4. 验收清单

| 项 | 状态 | 备注 |
|---|---|---|
| `bun run typecheck` 通过 | ✅ | `tsc --noEmit` 退出 0，无输出 |
| 新增类型基本不引入运行时代码 | ✅ | 仅 `errors.ts` 含 `ChovyError` 类 + 2 个辅助函数（doc 明确指定） |
| 旧 `agent.ts` / `echo.ts` 仍编译通过 | ✅ | 增量改动均为可选字段，向后兼容 |
| 错误日志格式 `chovy.error: <CODE> <message>` 可被 logger 识别 | ⏳ | 接入留给 step-03（已通过 `formatChovyError` 暴露规范输出） |

---

## 5. 风险登记 / 给后续步骤的提示

| # | 风险 / 待办 | 触发步骤 |
|---|---|---|
| R-01-1 | `ProviderInfo.capabilities` 当前是 `optional`，在 step-17 时需升级为必填，并同步 7 个 provider scaffold + `src/providers/capabilities.ts` 落地真实值 | step-17 |
| R-01-2 | `Tool.{descriptions, family, checkPermissions}` 当前是 `optional`；step-06/07 需切换为必填并迁移 `echo` 工具 | step-06, step-07 |
| R-01-3 | `ToolContextDraft` / `ToolResultDraft` 仅作 *signature anchor*；step-06 完成后应去掉 `Draft` 后缀并替换 `agent/agent.ts` 中直接使用旧 `ToolResult` 的链路 | step-06 |
| R-01-4 | `AgentRole` 字面量统一为 `'explorer'`（与 architecture.md §4.1 一致）；step-19 若需 `'explore'` 则需在内置 agent 文档中二选一统一 | step-19 |
| R-01-5 | `errors.ts` 是 `types/` 目录中**唯一含运行时代码**的文件——若后续审查觉得违反"types 纯类型"约定，可考虑迁到 `src/errors/` 顶层（暂保留以贴合 step 文档示例） | 任意 |

---

## 6. 接口冻结 / 草案分级

| 类型 | 阶段 | 后续修改许可 |
|---|---|---|
| `ChovyError`、`ErrorCode`、`isChovyError`、`formatChovyError` | **冻结** | 仅可向 `ErrorCode` 联合**追加**新码；不可移除 / 重命名 |
| `ChatMessage`、`ToolCall`、`ToolResult`、`ChatCompletion` | **半冻结** | 只允许追加可选字段；现有字段语义稳定 |
| `ProviderCapabilities`、`MemoryRecord`、`MemoryQuery`、`HookEvent`、`HookHandler`、`ContextBudget` | **草案** | step-17 / 24 / 13 / 27 完成时定稿；并行 worker 应只读引用，不可绕过类型走"私有扩展" |
| `Tool` 的可选 ATP 字段、`ToolContextDraft`、`ToolResultDraft`、`SubAgentHandle`、`BuiltInAgentDefinition`、`GoalState`、`Skill`、`SkillNode` | **草案** | step-06/12/18/19/23/29 完成时定稿 |

---

## 7. 文件清单（git diff 对应）

```
A  src/types/errors.ts
A  src/types/agent.ts
A  src/types/memory.ts
A  src/types/goal.ts
A  src/types/skill.ts
A  src/types/hook.ts
A  src/types/context.ts
M  src/types/messages.ts        (additive: id / ts / reasoning / annotations)
M  src/types/provider.ts        (additive: ProviderCapabilities + optional ProviderInfo.capabilities)
M  src/types/tool.ts            (additive: ATP draft + v2 draft types)
M  src/types/index.ts           (barrel: 7 new exports)
A  docs/complete/step-01-completion.md   ← 本文
```

---

## 8. 下一步候选

- **step-02 — config & secrets**（Phase A，无依赖，可立即接续）
- **step-03 — logger & telemetry**（Phase A，无依赖；本步暴露的 `formatChovyError` 在此被 logger 识别）
- **step-04 — fs & paths**（Phase A，无依赖）
- **step-05 — cli shell**（Phase A，无依赖；建议 02-04 之后再做）

按 `docs/README.md §4` 的 5-worker 推荐切分，下一步如果仍由本 worker 推进，建议 **step-02 → step-03 → step-04 → step-05** 串行完成 Phase A。
