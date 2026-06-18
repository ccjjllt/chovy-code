# Step 11 — Meta Tools（TodoWrite / AskUserQuestion / Skill / Agent）

**Phase**: B | **依赖**: 06 | **可并行**: ✅ | **估时**: 5h

## 目标

实现 4 个"元工具"——它们不直接修改世界，而是改变 agent 的工作方式：

| 工具 | 作用 | 依赖步骤 |
|---|---|---|
| TodoWrite | agent 自维护 task list（推动多步任务） | — |
| AskUserQuestion | 主动向用户提问；UI 弹选项 | — |
| Skill | 调用一个技能（执行注入的 system fragment） | step-29 真实落地 |
| Agent | 派生子 agent；本步给最小 stub，真实执行在 step-18 |

## 产物

```
src/tools/meta/
├── todoWrite.ts
├── askUserQuestion.ts
├── skill.ts             # stub（要求 step-29 完成）
├── agent.ts             # stub（要求 step-18 完成）
└── index.ts
```

## TodoWrite

```ts
schema: z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(['pending','in_progress','completed']),
    priority: z.enum(['low','medium','high']),
  })),
});
```

- 持久化到 ctx.session.todoList（内存）；
- 同时 echo 到 UI 的 TodoPanel（步骤 22 / 30 渲染）；
- 一次最多 50 条；in_progress ≤ 1 项约束（与 cc-haha ZCode 一致）。

## AskUserQuestion

```ts
schema: z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string().max(12),
    multiSelect: z.boolean().optional(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string(),
      preview: z.string().optional(),
    })).min(2).max(4),
  })).min(1).max(4),
});
```

- 通过 UI 浮层等用户选择；返回 `{ answers: Record<question, label> }`；
- 在非 TTY 模式下立即返回 `{ ok: false, errorCode: 'TOOL_DENIED', content: '非交互环境无法提问' }`；
- 用户答 "Other" 时允许自由文本。

## Skill（stub）

```ts
schema: z.object({
  skill: z.string(),
  args: z.string().optional(),
});
async run() {
  return { ok: false, content: 'SkillTool stub: implemented in step-29.', errorCode: 'INTERNAL' };
}
```

## Agent（stub）

```ts
schema: z.object({
  description: z.string().max(80),
  prompt: z.string(),
  subagent_type: z.enum(['Explore','Plan','Verify','Critic']).optional(),
  run_in_background: z.boolean().optional(),
});
async run(args, ctx) {
  if (!ctx.spawnSubAgent) return { ok: false, content: 'sub-agent runtime not ready (step-18)', errorCode: 'INTERNAL' };
  return ctx.spawnSubAgent(args);
}
```

后续步骤填实 `ctx.spawnSubAgent`。

## 验收标准

- TodoWrite：写入后再写入会合并（idempotent on id 缺失则按下标）；
- AskUserQuestion：在 REPL 中能看到选项 UI 并可选择；
- Skill / Agent：stub 报错信息明确指向后续步骤。

## 参考源

- `cc-haha/src/tools/TodoWriteTool/`、`AskUserQuestionTool/`、`AgentTool/`、`SkillTool/`

## 风险

- 交互工具在非交互环境下死锁 → 已在协议中定义"非 TTY 直拒"。
