# Step 06-07 验收追补报告

> 验收日期：2026-06-18  
> 范围：`docs/step-06-tool-protocol-v2.md`、`docs/step-07-tool-budget-allocator.md`、`docs/protocols/tool-v2.md`、`docs/complete/step-06/07-*`、`源码解析.md`、Phase A 追补项  
> 结论：B1 可供下游依赖；本轮修复了 1 个 Phase A 错误输出问题与 3 个 step06/07 边界问题。

---

## 1. 依据

- `docs/README.md`
- `docs/architecture.md`
- `docs/innovations.md`
- `docs/step-01-types-and-error-model.md` 到 `docs/step-07-tool-budget-allocator.md`
- `docs/protocols/tool-v2.md`
- `docs/complete/step-01-05-acceptance.md`
- `docs/complete/step-06-tool-protocol-v2.md`
- `docs/complete/step-07-tool-budget-allocator.md`
- `源码解析.md`

参考 cc-haha 时只取工具分层、权限硬边界、feature gate、本地可观测性、prompt/tool shape 诊断等工程模式；未复刻 GrowthBook、TEAMMEM、Docker/VM sandbox、Buddy、语音模式等本仓库明确排除项。

---

## 2. 修复项

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| V1 | CLI catch 分支把 `ChovyError` 转成 `.message` | malformed config 等路径丢失 `chovy.error: CONFIG_INVALID ...` | `src/cli/index.tsx` 新增 `logError(err)`，保留 Error 对象给 logger |
| V2 | `Tool.run` 类型只允许 `Promise<string \| ToolResult>` | 同步返回 `string` 的 legacy 工具无法类型兼容 | `Tool.run` 改为 `string \| ToolResult \| Promise<string \| ToolResult>` |
| V3 | ATP 在 `budgetTokens <= 0` 时不会裁掉 lean baseline | 极端低预算仍可能注入全部工具描述 | `describeTools()` 用 `budgetCap = max(0, budgetTokens)`，零预算也走 drop 分支 |
| V4 | `RegExp.test()` 未复位 `lastIndex` | 带 `g` / `y` 标志的 `fullTriggers` 可能间歇性漏命中 | `relevance.ts` 增加 `testPattern()`，匹配前复位 |

---

## 3. 实测验收

| 命令 / 场景 | 结果 |
|---|---|
| `bun run typecheck` | PASS |
| `bun run scripts/smoke-step07.ts` | PASS；6 条 `tools.described` telemetry，含 budget=0 case |
| `bun run scripts/smoke-step-04.ts` | PASS；20 项检查通过 |
| `bun src/cli/index.tsx`（非 TTY 无参） | PASS；输出 `chovy.error: CONFIG_INVALID interactive REPL requires a TTY ...` |
| `bun src/cli/index.tsx --permission-mode nope provider list` | PASS；输出 `chovy.error: CONFIG_INVALID unknown --permission-mode ...` |
| 临时 `CHOVY_HOME` 无 secret 后 `chovy chat hello` | PASS；输出 `chovy.error: PROVIDER_NOT_READY ...` |
| malformed `config.json` 后 `provider list` | PASS；输出 `chovy.error: CONFIG_INVALID <path> is not valid JSON ...` |
| BOM `config.json` 后 `loadConfig().provider` | PASS；返回 `kimi` |

---

## 4. B1 接口确认

- 未破坏 `Tool` / `ToolContext` / `ToolResult` / `PermissionPreflight` 字段语义。
- `DescribeOptions` / `DescribedTool` 签名保持可兼容；step-07 仅使用可选字段扩展。
- `describeTools()` 保持 schema 输出字段存在；ATP 只切换描述层级，不改变 schema 注入策略。
- `tools.described` telemetry 不包含用户消息内容，只记录计数、预算、role。

---

## 5. 后续提醒

1. step-12 接权限引擎时，`checkPermissions` 必须成为 6 层引擎的第 1 层；工具自己的 `deny` 对所有权限模式免疫。
2. step-15/16 构建 system prompt 时应直接消费 `describeTools()`，不要回退到 `describeToolsLegacy()`。
3. step-17 若提供 provider-aware tokenizer，应通过 `modelTokenizer` 传入 ATP，替换 chars/4 估算。
4. step-30 formal tests 可把 `scripts/smoke-step07.ts` 的 6 个 case 转成 `bun:test`。
