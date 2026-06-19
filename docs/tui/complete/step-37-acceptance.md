# Step 37 — 帧缓存 + Companion 播放器组件 验收报告

## 概要

**Phase**: K | **依赖**: 36
**完成时间**: 2026-06-20

根据 `docs/tui/step-37-companion-player.md` 和架构文档的约束，已成功完成了 Companion 播放器组件和缓存机制的实现。相关的状态机制、帧缓存、以及 UI 的后备处理都已就绪。

## 产物验证

以下文件已创建/修改，并完全遵循 `docs/tui/architecture.md` 的 B9 屏障接口冻结约束：

- **`src/companion/types.ts`**:
  - 新增 `CompanionState` 联合类型和 `CompanionFrame` 接口。
- **`src/companion/cache.ts`**:
  - 实现 `cacheDirFor(gifPath)`：基于 GIF 文件路径及最后修改时间的 SHA-1 哈希生成缓存目录。
  - 实现 `loadFramesCached`：如果本地已缓存 `meta.json` 及 ANSI 帧则快速读取（< 50ms），否则调用 `decodeGif` 进行解码并将 `.ansi` 及 `meta.json` 安全写入缓存目录（通过 `safeFs` 原子写入）。
- **`src/companion/ascii-fallback.tsx`**:
  - 实现 `FALLBACKS` 字典映射五种不同状态的字符动画，并在 `<AsciiFallback />` Ink 组件中按 500ms 进行帧切换。
- **`src/companion/player.tsx`**:
  - 实现 `<CompanionPlayer />` 组件：负责通过 `AbortController` 从缓存中加载动画序列，在渲染前安全释放（避免内存泄露及 UI 卡顿）。
  - 内置了最大 12fps （≥80ms 间隔）的帧率限制控制（基于 `delayMs` 和 `setTimeout` 递归）。
- **`src/companion/index.ts`**:
  - 定义并导出了 `CompanionHandle` 和挂载函数签名，以满足 B9 的暴露要求，供后续步骤（39/40）挂载和调度状态机时使用。
- **`scripts/smoke-step37.ts`**:
  - 基于 `bun:test` 编写冒烟测试，模拟 1x1 透明 GIF 对 `cacheDirFor` 和 `loadFramesCached` 的缓存未命中和命中的执行开销进行断言验证。测试运行通过。

## 验收标准自检

- [x] `bun run typecheck` 零错误通过。
- [x] `scripts/smoke-step37.ts` 冒烟测试跑通：第一次耗时进行了解码，第二次读取直接命中缓存。
- [x] 代码中未使用 `cc-haha` 遗留的 Sprite 数据数组以及多余的 `IDLE_SEQUENCE`。
- [x] 所有文件 IO 均通过 `safeFs` 隔离层，无原生 `fs` 或非跨平台兼容的代码。
- [x] 组件和缓存逻辑设计中已考虑到 `CHOVY_NO_COMPANION=1` 的环境逃生舱需求：无有效帧时，安全降级至 ASCII 兜底渲染。

## 风险管理声明
ANSI 缓存读写采用了 UTF-8 原生文本支持方式。已在 `player.tsx` 中加入了 `AbortController` 取消加载信号的处理，避免快速脱焦时的多余运算；并且通过 `safeFs.write` 的底层 atomic 机制（自动 tmp 文件 rename）防止了多实例并发写入产生的破损或乱码。
