# 优化与新特性集成：上下文阈值修复与阶跃星辰接入

**日期**: 2026-06-20

## 1. 上下文阈值（Context Threshold）修复与优化

### 问题背景
用户在配置向导中自定义添加了模型（例如 `siliconflow/nex-agi/Nex-N2-Pro`），并将上下文窗口设为 `256000`。但在 TUI 界面上（HeaderBar 处），仍然只显示了该服务商硬编码的默认值（128k）。虽然底层通过 `capabilities.ts` 已经拦截了配置，但负责预算计算和 UI 展示的 `thresholds.ts` 意外绕过了这一层拦截逻辑。

### 修复方案
修改了 `src/context/thresholds.ts` 的内部实现，使其完全解耦于静态配置字典 `CAPS`：
- 移除了对 `CAPS[provider]` 的直接读取。
- 引入 `src/providers/capabilities.ts` 中的 `getCapability(provider)` 方法进行动态解析。
- **效果**：无论在何种场景下，`thresholds.ts` 在计算 Token 预算及在 TUI 顶部渲染容量时，都会优先读取并完全尊重用户在 `~/.chovy/config.json` 中的 `customModels` 设定的 `contextWindow`。用户现在可以自由输入任何大小（例如 500k、1000k），并且 TUI 会即时无缝地渲染并使用新的百分比预算。

---

## 2. 阶跃星辰 (StepFun) 供应商接入

### 功能说明
参考 `mimocode` 的底层实现架构，将阶跃星辰（StepFun）全面接入到了 `chovy-code`。此改动让系统可以完整利用其原生的长文本及模型工具调用能力。

### 改动细节
1. **API 端点与兼容性注册** (`src/providers/chovyProvider.ts`)
   - 增加对 `https://api.stepfun.com/v1` 的路由代理，使用与 OpenAI 一致的 `OpenAICompatProvider` 的兼容格式完成接入。
2. **凭据层支持** (`src/config/secrets.ts`)
   - 添加环境变量支持 `STEPFUN_API_KEY` 以及对应的 BaseURL 变量 `STEPFUN_BASE_URL`。
3. **能力矩阵** (`src/providers/capabilities.ts`)
   - 注册 `stepfun` 供应商并定义其特性（`contextWindow: 256_000`、支持 JSON Mode、原生工具调用以及流式输出功能）。
4. **内置模型列表** (`src/providers/chovyModels.ts`)
   - 添加以下推荐模型供用户在 TUI 面板中直接选用：
     - `step-3.5-flash` （主打极速与大上下文 - 256K）
     - `step-1-32k` （均衡版本 - 32K）
     - `step-2-16k` （轻量版本 - 16K）
5. **类型强化与配置合并** (`src/config/config.ts`, `src/types/provider.ts`)
   - 更新类型联合（Union Types）和 Zod 数据校验框架中的字面量选项，支持 `stepfun` 的存取流转。
6. **Web Fetch 小模型兜底** (`src/tools/web/smallModel.ts`)
   - 当系统断网或需要极速做网页抽取总结时，指定了 `step-3.5-flash` 作为该供应商在离线提取工作中的首选小模型（Fallback/Summarizer Model）。
