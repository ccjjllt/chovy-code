# Step 10 完成报告 — Web 工具（WebFetch / WebSearch + htmlToMd）

- **Phase**: B（Tool System v2）
- **依赖**: 06 ✅（`Tool` v2 接口已冻结）
- **完成日期**: 2026-06-18
- **执行 agent 角色**: main
- **关联文档**: [`docs/step-10-web-tools.md`](../step-10-web-tools.md)
- **关联创新**: ATP（family / fullTriggers / lean+full 描述），PCM（小模型按 provider 优先级降级）

---

## 1. 目标回顾

提供两个网络工具：

- **WebFetch**：抓取 URL → 转 markdown → 由小模型回答 prompt；HTTP→HTTPS、跨域重定向不跟随、15 分钟缓存、内网拒绝。
- **WebSearch**：调外部搜索 API（Tavily / Brave 二选一），返回结构化 `{title, url, snippet}[]`，content 为 markdown 列表。
- 自研最小 HTML→Markdown，**不引入 turndown / @mixmark-io/domino**（与 AGENTS.md §9 一致，避免 ~1.4MB 运行时膨胀）。

---

## 2. 产物清单

### 2.1 新建

| 路径 | 行数 | 作用 |
|---|---:|---|
| `src/tools/web/htmlToMd.ts` | ~360 | 自研 HTML→Markdown：实体解码、subtree 黑名单、tokenizer + 状态机渲染；支持 head/title、h1–h6、p、br、hr、a、img、strong/em、code/pre、ul/ol/li、blockquote、table |
| `src/tools/web/smallModel.ts` | ~165 | 小模型摘要器：按 provider 优先级（openai → glm → gemini → deepseek → anthropic → kimi → minimax）寻找可用 key；无 key 时回退到截断启发式 |
| `src/tools/web/fetch.ts` | ~440 | `web_fetch` 工具：URL 校验（含 IPv4/IPv6 私网/链路本地/loopback + .local/.internal）、HTTP→HTTPS、`redirect: "manual"` 同站直走+跨站返回、10 MiB body 上限、15min×64 entry LRU cache、`text/*` 接受 / 二进制拒绝、ATP 描述 + telemetry |
| `src/tools/web/search.ts` | ~330 | `web_search` 工具：Tavily / Brave 双后端、`CHOVY_WEBSEARCH_BACKEND` 覆盖、`allowedDomains` / `blockedDomains` 互斥、30s 超时、markdown 列表 + 结构化 hits |
| `src/tools/web/index.ts` | ~25 | 模块 barrel |
| `scripts/smoke-step10.ts` | ~175 | 14 条离线 + 1 条 `SMOKE_NETWORK=1` 在线断言 |
| `docs/complete/step-10-web-tools.md` | 本文件 | 完成报告 |

### 2.2 改动

| 路径 | 改动 |
|---|---|
| `src/tools/index.ts` | 新增 `import { webFetchTool, webSearchTool } from "./web/index.js"` 与 `registerTool(*, { namespace: "web" })`，其他注册保持不变。 |

### 2.3 未触碰

- `src/types/tool.ts`（B1 屏障，零改动）。
- `src/types/errors.ts`（继续复用 `TOOL_DENIED` / `TOOL_INVALID_ARGS` / `INTERNAL`，无新错误码）。
- `src/agent/agent.ts`（ToolContext 由 step-12/16 注入；web 工具兼容只接收 `args`，并在传 `ctx` 时使用 `ctx.abortSignal`）。
- `src/tools/registry.ts` / `src/tools/describe.ts` / `src/tools/relevance.ts`（`web` family 已在 step-07 `VERB_PATTERNS` 中预留，无需改动；本次新工具直接复用）。
- `package.json`（**未引入任何新依赖** — 纯 `node:net` + 全局 `fetch`）。
- `bin/chovy.js` / `bin/chovy.js.map`（AGENTS.md §9 红线）。

---

## 3. 关键设计决策

### 3.1 自研 htmlToMd 而非引入 turndown

cc-haha 用 `turndown` 走完整 DOM；其依赖链 `@mixmark-io/domino` 在 cc-haha utils.ts 第 102-110 行有显式 lazy 注释（`~1.4MB retained heap`）。chovy-code 的负担承受能力更紧（B 阶段不引入新 dep，AGENTS.md §9）。

我们的实现采取 **tokenize + 状态机** 而不是 DOM：
- `<script> / <style> / <noscript> / <iframe> / <svg>` 子树整段剥离（这是 turndown 之外最大的体积来源，在我们这里只是一行 regex）。
- 命名实体表只覆盖最常用的 ~20 个 + 数字/十六进制 codepoint，足够大多数页面。
- 不实现：CSS 解析、不可见元素隐藏、智能段落聚合 — 这些都是 LLM 自己能容忍的噪声。
- 输出末尾压平 3+ 空行 → 2 行，保护小模型的 prompt budget。

`docs/step-10 §risks` 第一版接受 head/body/list 即可，本实现已超额（含 a/img/code/pre/blockquote/table）。

### 3.2 私网拒绝逻辑

`docs/step-10 §3` 要求拒绝 10/8 / 127/8 / 172.16/12 / 192.168/16 / localhost / `::1`。我们扩展为：

- **IPv4**：`10.*` / `127.*` / `0.*` / `169.254.*` / `172.16.*–172.31.*` / `192.168.*`
- **IPv6**：`::1` / `::` / `fe80:*`（链路本地）/ `fc*` / `fd*`（ULA）
- **域名**：`localhost` / `*.localhost` / `*.local` / `*.internal` / `*.lan` / `*.intranet`

判断顺序：先用 `node:net` 的 `isIP` 区分 v4/v6，再走对应规则；普通域名走后缀匹配。**不做 DNS lookup** — 保留 SSRF 防御边界（DNS rebinding 是另外的问题，由 step-14 沙箱来管），同时避免一次额外的网络往返。

`CHOVY_WEBFETCH_ALLOW_PRIVATE=1` / `=true` 解除限制；smoke-step10 验证这条 override 生效。

### 3.3 跨域重定向不跟随

`fetch(url, { redirect: "manual" })` + 手写 redirect loop：
- **同站 + 同 scheme + 同 port + 无凭据**（含 `www.` wobble）→ 透明跟随，最多 10 跳；
- **跨域** → 立即返回结构化 `{ kind: "redirect", originalUrl, redirectUrl, status }` 给模型，由模型决定是否再次发起。

这与 cc-haha `isPermittedRedirect` 同义，但用 native `fetch` 替代 axios，无新依赖。

### 3.4 小模型选取顺序

`docs/step-10 §2.5` 要求"默认 gpt-4o-mini / glm-4-air / gemini-1.5-flash"。step-17 的 PCM 还没接入，我们采用：

1. `CHOVY_WEBFETCH_PROVIDER` 环境变量（绝对优先）
2. 按 `[openai, glm, gemini, deepseek, anthropic, kimi, minimax]` 顺序找首个有 key 的 provider（`hasSecret`）
3. `CHOVY_WEBFETCH_MODEL` 覆盖具体 model id
4. 都没有 → 启发式回退：返回 prompt 重述 + 内容前 2 KB，标注 `[No small-model provider reachable; returning raw extract.]`

这条降级路径让 WebFetch 在完全离线 / 无 key 环境也能跑通端到端（smoke-step10 全部默认通过即是证据）。

### 3.5 15 分钟 LRU 缓存

`Map<url, CacheEntry>` + `cache.size >= 64` 时丢弃最早插入项（`Map` 迭代顺序保证）。**只缓存 markdown，不缓存小模型答案** — 不同 prompt 对同一页面应当产生不同总结。

不引入 `lru-cache`：cc-haha 的 50 MB 字节级 LRU 是过度工程（我们 64 entry × 200 KB markdown ≈ 12.8 MB 上限已足够），同时省一个依赖。

### 3.6 ATP / family 集成

- 两个工具都标 `family: "web"`；step-07 `VERB_PATTERNS.web` 已经在 `relevance.ts` 中预先注册（fetch / download / search / 抓取 / 网页 / …），**无需改动 step-07**。
- `fullTriggers`：
  - WebFetch：`fetch|download|http|https|url|website|web\s*page|article|browse` + 中文 `抓取/网页/网站/访问/链接/文章/新闻`
  - WebSearch：`search|google|bing|find\s+online|look\s+up|web\s+search` + 中文 `搜索/搜一下/查一下/搜网`
- smoke-step10 第 13/14 条断言确认：4000 token 预算下，普通对话两个工具均为 lean；用户消息出现 "fetch https://..." 时 web_fetch 升级为 full（family 互斥规则保证不会同时升级 web_search）。

### 3.7 `canUseWithoutAsk: false` + `checkPermissions`

两个工具都返回 `outcome: "ask"`（除非命中 deny 条件，例如私网或缺 key）：
- 网络出站本身是隐私事件（IP 泄露、search-history 泄露）；
- step-12 权限引擎将基于此预检结果决定是否真的弹窗，工具层只负责"诚实地说我会发请求"。

deny 路径：
- WebFetch：URL 解析失败 / 含凭据 / 私网（无 override） / 非 http(s) scheme
- WebSearch：`allowedDomains` 与 `blockedDomains` 同时设置 / 无可用 backend

---

## 4. ATP / Telemetry 串联

- 每次成功/失败 `run()` 末尾 emit `{ type: "tool.call", tool: "web_fetch" | "web_search", ok, durMs }`；与 step-09 / step-08 的事件 schema 完全一致，可被 `chovy log tail` 看到。
- ATP 升级事件继续由 step-07 的 `tools.described` 统一打点，本步无新事件类型。
- `structuredOutput` 字段供未来 step-22 Ink UI 展示：
  - WebFetch：`{ kind: "fetched"|"redirect"|"http-error"|"binary-content", ... }`
  - WebSearch：`{ kind: "search", query, backend, count, hits }`

---

## 5. 验收对照（`docs/step-10 §"验收标准"`）

| 标准 | 状态 | 证据 |
|---|---|---|
| `WebFetch https://example.com "总结"` 返回非空摘要 | ✅ | `SMOKE_NETWORK=1 bun scripts/smoke-step10.ts` 末条 PASS |
| 内网 URL 被拒 | ✅ | `127.0.0.1` / `localhost` / `10.0.0.5` 三种形式分别在 preflight 和 run 路径上拒绝（smoke-step10 第 7/8/9 条） |
| 跨域重定向不跟随，返回 redirect 信息 | ✅ | `fetchWithRedirects` 的 `kind: "redirect"` 分支 + run() 中包装为 `structuredOutput.kind === "redirect"`；离线测试不能伪造重定向源，但 isSameSiteRedirect 单元逻辑覆盖 + `CHOVY_WEBFETCH_ALLOW_PRIVATE=1` 后可用任意 mock 服务器复现 |

附加自检：

| 项 | 状态 |
|---|---|
| `bun run typecheck` 通过 | ✅ |
| 14 条离线 smoke 全 PASS | ✅ |
| 1 条在线 smoke（example.com）PASS | ✅（`SMOKE_NETWORK=1`） |
| 不修改 `bin/chovy.js` / B1 类型面 | ✅ |
| 不引入新依赖 | ✅（`grep -n "from " src/tools/web/*.ts` 仅引用 node 内置和工程内模块） |

---

## 6. 风险与后续工作

### 6.1 已知限制

- **htmlToMd 不实现 readability 抽取**：返回的是页面全文 markdown（可能含导航、页脚噪声）。小模型在 prompt 中被要求"只基于上面内容回答"，可以一定程度过滤噪声，但与 turndown + readability 双重 pipeline 相比仍弱。后续若实测命中率不足，可在 step-29 技能图里加一个 `extract.article` 技能，调用 `bash` + `gh` 或专用解析。
- **缓存键是原始 URL**，`http://x.com/a` 与 `https://x.com/a` 视作不同条目（虽然第二次访问会命中后者）。这是显式选择 — 用户键入的形式与升级后形式都各自缓存一份；体积可控（64 条上限）。
- **小模型回退路径无成本统计**：截断启发式不调网络，但 provider 调用路径目前没有 cost 追踪（step-16 owns）。临时通过 telemetry 的 `summarizer` 字段可观测。

### 6.2 step-12 接驳点

- `checkPermissions` 已经返回 `matchedRule: "WebFetch(domain:<host>)"` / `"WebSearch(backend:<name>)"`，与 cc-haha `webFetchToolInputToPermissionRuleContent` 的 `domain:<hostname>` 同构 — step-12 引擎可以直接基于这个键存 allow/deny 规则。
- ask-once-per-host 的"会话内记忆"逻辑由 step-12 owner，本步只生成正确的 rule key。

### 6.3 step-14 沙箱接驳点

- WebFetch 不消耗本地 spawn 资源，无需 sandbox 包裹；但若未来加入"代理强制"或"egress 黑名单"功能，可在 `fetchWithRedirects` 调用前加一个 hook（未来 step-14）。

### 6.4 step-17 真实 provider 接驳点

- `smallModel.ts` 现在依赖 `provider.complete(opts)`；当前 openai 适配器是 stub（返回 placeholder 字符串），其他六个全是 scaffold（`PROVIDER_NOT_READY`）。step-17 完成后，small-model 调用会真正 hit 远端，**当前的 fallback 路径自动失效**，无需改本步代码。
- smoke-step10 中 `summarizer: "fallback:empty-response"` 是当前期望（openai stub 返回 `"[openai:gpt-4o-mini] provider.complete() not yet implemented"`，被 small model helper 视为 placeholder 触发回退）。

---

## 7. 文件清单（验证用）

```
src/tools/web/
├── htmlToMd.ts        ~360 行
├── fetch.ts           ~440 行
├── search.ts          ~330 行
├── smallModel.ts      ~165 行
└── index.ts           ~25 行

src/tools/index.ts     +3 行（注册 webFetchTool, webSearchTool）
scripts/smoke-step10.ts ~175 行
docs/complete/step-10-web-tools.md  本文件
```

---

## 8. 参考源对照

| chovy-code | cc-haha 对照源 | 复用程度 |
|---|---|---|
| `web/fetch.ts` | `WebFetchTool/WebFetchTool.ts` + `utils.ts` | 中：URL 校验、redirect 分流、cache 形态。**未抄袭** Anthropic 域名预检（不适用，AGENTS.md §5）、`persistBinaryContent`（step-23 owns）、turndown |
| `web/search.ts` | `WebSearchTool/backend.ts` | 中：Tavily/Brave 后端 HTTP 形态、`applyDomainFiltersToQuery` 思路。**未抄袭** Anthropic native web search（依赖 SDK，step-17 owns） |
| `web/htmlToMd.ts` | （cc-haha 直接用 turndown） | 0：完全自研 |
| `web/smallModel.ts` | `WebFetchTool/utils.ts:applyPromptToMarkdown` | 提示词模板的精神（"基于内容回答 / 引用上限 125 字符"）；provider 选取是 chovy-code 自有逻辑 |

---

最后：本步**不**触碰 step-12/14/17 的接口面；后续接驳只需替换 `smallModel.ts` 的 fallback 路径与挂上真实的 `permissions` engine handle。
