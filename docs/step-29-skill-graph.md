# Step 29 — Skill Graph（CSG 创新）

**Phase**: I | **依赖**: 06,16 | **可并行**: ✅ | **估时**: 6h

## 目标

实现 **CSG — Conditional Skill Graph**：技能不再是平铺目录，而是有 `requires` / `provides` / `conflicts` 的有向图；
Skill Planner 按用户意图选择最少必要技能链注入。

## 产物

```
src/skills/
├── registry.ts          # 注册中心
├── graph.ts             # 拓扑搜索
├── planner.ts           # 主选择器
├── intentExtractor.ts   # 意图标签抽取
├── bundled/
│   ├── commit.ts
│   ├── review.ts
│   ├── refactor.ts
│   ├── format.ts
│   ├── test.ts
│   ├── pr.ts
│   └── ...
└── index.ts
src/tools/meta/skill.ts  # 替换 step-11 的 stub
```

## Skill 接口

```ts
export interface Skill {
  name: string;                          // 'commit'
  summary: string;                       // 一行（lean）
  triggers: {
    keywords?: string[];                 // 命中即提分
    patterns?: RegExp[];
    when?: 'on-request' | 'pre-tool' | 'always';
  };
  requires?: string[];                   // ['format']
  provides?: string[];                   // ['conventional-commits']
  conflicts?: string[];                  // ['legacy-commits']
  systemFragment: string;                // 注入到 system prompt 的内容
  budgetTokens: number;                  // 自报告
}

export interface SkillNode { skill: Skill; score: number; }
```

## Bundled skills（最小集）

| name | provides | requires | conflicts | tokens |
|---|---|---|---|---|
| commit | conventional-commits | — | legacy-commits | 400 |
| review | code-review | — | — | 600 |
| refactor | safe-refactor | format | — | 500 |
| format | format | — | — | 200 |
| test | run-tests | — | — | 300 |
| pr | pr-flow | commit | — | 400 |
| ts-fix | typecheck-loop | format | — | 600 |

## Planner 流程

```
input: { latestUserText, recentMessages, agentRole, goal? }
1. intentExtractor → tags[]（如 ['commit','bug-fix']）
   方法：
   - 关键词匹配 + 用户消息中的命令式动词
   - 最近 ToolCall 中已经发生的（如有 git diff → 隐含 commit 意图）
2. score(skill, tags) = sum(matched_keywords) * 1 + provides_overlap_with_goal * 0.5
3. seeds = top-K skills by score
4. dependency closure：BFS skill.requires → 把 transitively required skills 加入
5. conflict resolution：同 conflicts 组保留 score 最高一个
6. budget enforce：累加 budgetTokens 直到 ContextBudget.skills；
   超出时丢弃 score 最低（除非它是其他 skill 的 require → 否则触发"丢弃 + 也丢弃依赖它的 skill"）
7. 输出 SkillNode[]
```

## SkillTool（替换 step-11 stub）

```ts
schema: z.object({
  skill: z.string(),
  args: z.string().optional(),
});
async run({ skill, args }, ctx) {
  const def = skillRegistry.get(skill);
  if (!def) return { ok:false, content:`unknown skill: ${skill}` };
  // 临时把 def.systemFragment 注入到本轮额外 system 段，并返回 ack
  ctx.session.activeSkillFragments[skill] = renderFragment(def, args);
  return { ok:true, content:`Skill '${skill}' activated for this turn.` };
}
```

QueryEngine 在下一轮 buildEffectiveSystemPrompt 时把 `activeSkillFragments` 拼到 default layer 的 append。

## 自动 vs 手动

- 自动：Planner 在每轮 inspect 后给出建议 fragments；
- 手动：用户输入 `/commit "feat: ..."` 直接调用 SkillTool（CSG 仍解析依赖）。

## 持久化"已选 skill 链"签名

记录在 `~/.chovy/projects/<id>/skills.lock`：

```json
{
  "lastSelected": ["format","commit"],
  "ts": 1718700000000,
  "fingerprint": "abc123..."
}
```

下一会话恢复时，若意图变化不大，可立即复用上次选择，避免抖动。

## 验收标准

- 输入 "帮我修这个 bug 然后提交" → planner 选 [ts-fix, format, commit]；
- requires 缺失（如人为禁用 format）→ 报错"commit 需要 format"；
- conflicts 同台 → 报错并提示用户二选一；
- budgetTokens 总和 ≤ ContextBudget.skills。

## 参考源

- `cc-haha/src/skills/`（平铺技能；CSG 是 chovy-code 的差异化）

## 风险

- 意图抽取偏差大 → 第一版用规则；后续可加 small-model 评分。
