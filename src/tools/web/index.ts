/**
 * Web tools barrel (step-10).
 *
 * Exposes the two built-in web tools and shared utilities:
 *
 *   - `webFetchTool`  — `web_fetch` Tool v2 instance
 *   - `webSearchTool` — `web_search` Tool v2 instance
 *   - `htmlToMd`      — minimal HTML → Markdown converter (no turndown)
 *   - `clearWebFetchCache` — drop the 15-minute URL cache (tests / `/web cache`)
 *   - `summarizeWithSmallModel` — shared small-model wrapper for future tools
 *
 * Registration with the global registry happens in `src/tools/index.ts`
 * (alongside fs / exec tools) so consumers of `listTools()` see web tools
 * without an extra import.
 */

export { webFetchTool, clearWebFetchCache } from "./fetch.js";
export { webSearchTool } from "./search.js";
export type { SearchHit } from "./search.js";
export { htmlToMd } from "./htmlToMd.js";
export type { HtmlToMdOptions } from "./htmlToMd.js";
export { summarizeWithSmallModel } from "./smallModel.js";
export type { SummarizeOptions, SummarizeResult } from "./smallModel.js";
