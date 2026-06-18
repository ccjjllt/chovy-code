# Step 10 — Web Tools（WebSearch / WebFetch）

**Phase**: B | **依赖**: 06 | **可并行**: ✅ | **估时**: 4h

## 目标

提供两个网络工具：

- **WebSearch**：调外部搜索 API（默认走 Tavily / Brave，可配置）；
- **WebFetch**：抓取页面 → 转 markdown → 由小模型回答 prompt。

## 产物

```
src/tools/web/
├── search.ts
├── fetch.ts
├── htmlToMd.ts        # 简易 HTML → Markdown（基于 turndown 思路自研最小版）
└── index.ts
```

## 实现要点

### 1. WebSearch

```ts
schema: z.object({
  query: z.string(),
  maxResults: z.number().default(5),
});
```

后端：
- 默认 `TAVILY_API_KEY` 走 Tavily；
- 否则 `BRAVE_API_KEY` 走 Brave Search；
- 都缺则报错并提示设置。

返回结构化：`{ title, url, snippet }[]`，content 字段为 markdown 列表。

### 2. WebFetch

```ts
schema: z.object({
  url: z.string().url(),
  prompt: z.string(),
});
```

流程：
1. fetch(url)；自动 https；
2. 跨域重定向 → 不跟随，返回新 URL 给模型再次发起（参考 ZCode harness 行为）；
3. HTTP → HTTPS 升级；
4. text/html 经 `htmlToMd` 转 markdown；text/* 直接读；其他 MIME 拒绝；
5. 调用一个 *小模型*（默认 `gpt-4o-mini` / `glm-4-air` / `gemini-1.5-flash`）回答 prompt；
6. 缓存 15min（按 URL）。

### 3. 安全 / 隐私

- 默认拒绝内网地址（10/8、127/8、172.16/12、192.168/16、localhost、`::1`）；
- 通过 `CHOVY_WEBFETCH_ALLOW_PRIVATE=1` 解除；
- 不附带任何 cookies / credentials。

### 4. ATP 描述

```ts
// WebFetch
lean: 'Fetch a URL, convert to markdown, answer prompt against it.',
full: `Fetches a URL... HTTP→HTTPS; cross-host redirects returned not followed; cached 15 min.`,
```

## 验收标准

- `WebFetch https://example.com "总结"` 返回非空摘要；
- 内网 URL 被拒；
- 跨域重定向不跟随，返回 redirect 信息。

## 参考源

- `cc-haha/src/tools/WebSearchTool/`、`WebFetchTool/`

## 风险

- HTML 解析覆盖度低 → 第一版接受「头标签 + 正文 + 列表」即可；后续迭代。
