# Step 38 验收报告：吉祥物状态机 (Companion State Machine)

## 完成概况
本阶段在 Phase K 阶段顺利完成了吉祥物 5 种内部状态的接入，并通过 `CompanionState` 为后续 GIF UI 层渲染提供了精确的上下文支持。核心改动遵循了对 `runAgent` 流程“最小入侵”的原则。

## 具体验收成果

### 1. 状态机核心 (`src/companion/stateMachine.ts`)
- 实现了 `idle`、`work`、`think`、`done`、`error` 五大核心状态机 (`CompanionState` B9 接口联合不变量未破坏)。
- 加入了防抖自动衰退机制（Auto-decay）：其中 `done` 状态 5 秒后自动退回 `idle`；`error` 状态 8 秒后自动退回 `idle`。超时设定由常量声明，未写入外部 config 且转移逻辑保持幂等性。
- 通过进程内单例向外输出 `getCompanionStateMachine()` 以供 `repl.tsx` 调用。

### 2. 状态发布总线 (`src/companion/stateBus.ts`)
- 按照类似于 `agent/swarmBus.ts` 的模型，完成了 UI-only 级别的 pub/sub (事件广播) 总线架构。
- 订阅方法不触发外部遥测持久化请求，提供干净轻量的 `type CompanionEvent` 供 UI 多组件（如后续的 GIF player/bubble quip 等）订阅消费。

### 3. 皮肤渲染解析 (`src/companion/skin.ts`)
- 声明并输出了 `resolveGifPath(state, skinName, cwd)` 解析工具。
- 绑定默认皮肤（位于 `gif/`）。
- 成功提供针对用户自定义皮肤 (`~/.chovy/skins/`) 的检索能力并向上传递绝对路径。

### 4. `runAgent` 接入集成 (`src/cli/repl.tsx`)
- 生命周期关联：以 `useEffect` 集成，保证组件卸载时调用 `sm.dispose()` 进行资源安全释放。
- 发送拦截：在 `send()` 触发时，同步下发 `work` 及后续根据生命周期的 `done` 与 `error` 状态切分。
- 按时判活 (Think)：添加了 `Date.now() - lastToolTimeRef.current > 5000` 窗口检测；在 API stream Token 到达但 5s 期间仍未触发工具调用时自动推入 `think` 状态。

### 5. 质量校验
- `bun run typecheck` 通过。
- 新增独立 Smoke 测试 (`scripts/smoke-step38.ts`)：
  - [x] 成功校验状态从 `idle -> work -> done -> idle(5s)` 回退的健康度。
  - [x] 校验抛错时 `error -> idle(8s)` 恢复逻辑符合设定。
  - [x] 重复推入相同的 `state` 时，验证侦听器 spy 触发数为 1（幂等性成立）。

## 总结
第 38 步各项功能点和验收标准已逐一满足，未引入多余或违规的 npm 库。准备就绪，可以向 Step 39 的集成渲染发进！
