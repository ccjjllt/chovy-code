# Step 06 — Tool Protocol v2（含 ATP 创新基础）

**Phase**: B | **依赖**: 01 | **可并行**: ❌（B1 屏障，所有 B/D/E 等待） | **估时**: 5h

## 目标

把当前 `src/types/tool.ts` 升级为 **Tool Protocol v2**：
1. 引入 `ToolContext`（含 cwd / abortSignal / logger / permissions / spawnSubAgent 等）；
2. 引入 ATP 双重描述（lean / full + 触发器）；
3. 引入工具的 `checkPermissions` 钩子（与步骤 12 接驳）；
4. 提供 `ToolResult` 富类型（content + structuredOutput + meta）；
5. 提供 `family` 字段供 ATP 同族互斥使用。

## 产物

```
src/types/tool.ts             # 重构（保持名字向后兼容）
src/tools/registry.ts         # 加 namespace、版本、enable
src/tools/describe.ts         # 新：lean / full 选择器
src/tools/index.ts            # barrel
docs/protocols/tool-v2.md     # 工具作者指南（产物之一）
```

## 核心契约

```ts
export interface Tool<TArgs = unknown> {
  /** 唯一 id：snake_case */
  name: string;
  /** v2 协议版本号（用于以后扩展） */
  version?: 1 | 2;
  /** 同族互斥（ATP 用）；同一 family 一次只升一个 full */
  family?: string;

  /** 双重描述 */
  desc: {
    lean: string;
    full: string;
    examples?: string[];
  };
  /** 命中关键词时强制升级为 full */
  fullTriggers?: RegExp[];

  /** 参数 schema（zod，可被序列化为 JSON-Schema） */
  schema: ZodSchema<TArgs>;

  /** 用户可见名（StatusLine 显示） */
  userFacingName?(args: TArgs): string;

  /** 是否纯只读：默认从 family 推断 */
  isReadOnly?: boolean;

  /** 是否无需询问（与 permission engine 协作）*/
  canUseWithoutAsk?: boolean;

  /** 自身的权限预检（在 engine 第 1 层被调用） */
  checkPermissions?(args: TArgs, ctx: ToolContext): Promise<PermissionPreflight>;

  /** 真正的执行 */
  run(args: TArgs, ctx: ToolContext): Promise<ToolResult>;

  /** 渲染（可选，UI 层从 result.content 自动展示） */
  renderResult?(args: TArgs, result: ToolResult): React.ReactNode;
}

export interface ToolContext {
  cwd: string;
  abortSignal: AbortSignal;
  logger: Logger;
  permissions: PermissionEngine;
  hooks: HookEngine;
  /** 子 agent 派生入口（步骤 18 接入） */
  spawnSubAgent?: SpawnFn;
  /** 当前 ChovyConfig 快照 */
  config: ChovyConfig;
  /** 当前会话 id 与项目 id */
  sessionId: string;
  projectId: string;
}

export interface ToolResult {
  ok: boolean;
  /** 给模型看的文本 */
  content: string;
  /** 给 UI / 程序看的结构化输出（可选） */
  structuredOutput?: unknown;
  /** 副作用元数据（修改了哪些文件、运行了什么命令） */
  meta?: { filesChanged?: string[]; cmd?: string; durMs?: number; bytes?: number };
  /** 错误码（ok=false 时） */
  errorCode?: ErrorCode;
}

export interface PermissionPreflight {
  outcome: 'allow' | 'ask' | 'deny';
  reason?: string;
  /** 命中的内容特定规则（如 "Bash(git push:*)") */
  matchedRule?: string;
}
```

## ATP 描述选择器（接口冻结）

```ts
// src/tools/describe.ts
export interface DescribeOptions {
  budgetTokens: number;       // 留给所有工具描述的总预算
  recentMessages: ChatMessage[];
  lastToolCalls: string[];    // 上一轮调用过的工具
}

export interface DescribedTool {
  name: string;
  description: string;        // 实际注入的描述（lean 或 full）
  schemaJson: unknown;
  level: 'lean' | 'full';
}

export function describeTools(opts: DescribeOptions): DescribedTool[];
```

具体实现在 **步骤 07**；本步骤只冻结接口。

## 注册中心扩展

```ts
// src/tools/registry.ts
export interface RegisterOptions {
  namespace?: string;        // 'fs' | 'exec' | 'web' | 'meta'
  enabledWhen?: () => boolean; // feature gate
}
export function registerTool(tool: Tool, opts?: RegisterOptions): void;
export function listTools(filter?: { namespace?: string; enabled?: boolean }): Tool[];
```

## 与现有 echo 工具的兼容

`echo.ts` 升级为：

```ts
export const echoTool: Tool = {
  name: 'echo',
  family: 'meta',
  desc: {
    lean: 'Echo back input. Smoke-test only.',
    full: 'Echo back the provided message. Useful for testing the agent loop end-to-end. Returns input verbatim.',
  },
  schema: z.object({ message: z.string() }),
  isReadOnly: true,
  canUseWithoutAsk: true,
  async run(args) { return { ok: true, content: args.message }; },
};
```

## 验收标准

- 所有现有工具能编译通过新接口；
- `bun run typecheck` 通过；
- `describeTools({ budgetTokens: 100, ... })` 在预算 100 时不会注入 full；
- `Tool.run()` 旧返回 `string` 的工具被自动包装为 `{ok:true,content:string}`（兼容层）；后续工具用新格式。

## 参考源

- `cc-haha/src/Tool.ts`、`cc-haha/src/tools.ts`、`cc-haha/src/tools/*Tool/*.tsx`

## 风险

- 新接口拖累后续步骤（B1 屏障）→ 本步限定 ≤ 1 工作日；不引入运行时复杂逻辑。
