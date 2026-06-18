/**
 * `web_search` — Tool Protocol v2 search backend (step-10).
 *
 * Per `docs/step-10-web-tools.md §1`, the tool calls an external search
 * provider and returns a structured list of `{ title, url, snippet }` along
 * with a markdown-bullet content body the model can quote directly.
 *
 * Backend selection (first match wins):
 *
 *   1. `CHOVY_WEBSEARCH_BACKEND` env override — `"tavily"` | `"brave"`.
 *   2. `TAVILY_API_KEY` env or `~/.chovy/secrets/tavily` → Tavily.
 *   3. `BRAVE_API_KEY`  env or `~/.chovy/secrets/brave`  → Brave.
 *   4. Otherwise: refuse with a clear "set TAVILY_API_KEY or BRAVE_API_KEY"
 *      message so the user knows what to do.
 *
 * The cc-haha implementation also supports Anthropic's *native* web search
 * tool, but that depends on the Anthropic SDK / streaming integration that
 * step-17 owns; we deliberately stop at the two external backends so this
 * step compiles standalone and ships without provider plumbing.
 *
 * Privacy / safety:
 *   - Search backends never receive any user secrets other than their own
 *     API key. We do NOT forward project paths, environment, etc.
 *   - The query string is sent verbatim — searching itself is the leak the
 *     user explicitly opted into by calling this tool.
 *   - `signal` honors `ctx.abortSignal` so a cancelled run does not leave
 *     a dangling fetch.
 *
 * Output content body shape (the string the model sees):
 *
 *   ```
 *   Web search results for "<query>" via <backend>:
 *
 *   1. **<title>** — <url>
 *      <snippet…>
 *
 *   2. ...
 *
 *   REMINDER: cite sources in your response with markdown links.
 *   ```
 */

import { join } from "node:path";
import { z } from "zod";

import { chovySecretsDir } from "../../config/home.js";
import { safeFsSync } from "../../fs/index.js";
import { logger } from "../../logger/index.js";
import type { PermissionPreflight, Tool, ToolResult } from "../../types/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 20;
const SEARCH_TIMEOUT_MS = 30_000;

// ── Secret resolution ─────────────────────────────────────────────────────

/**
 * Lookup a non-provider API key (Tavily / Brave / ...). The first-class
 * `getSecret` helper is keyed to `ProviderId` only; rather than widen that
 * union here we replicate the env-then-file pattern locally.
 */
function readKey(envName: string, fileName: string): string | undefined {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const path = join(chovySecretsDir(), fileName);
    const raw = safeFsSync.read(path).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function getTavilyKey(): string | undefined {
  return readKey("TAVILY_API_KEY", "tavily");
}
function getBraveKey(): string | undefined {
  return readKey("BRAVE_API_KEY", "brave");
}

type Backend = "tavily" | "brave";

interface BackendSelection {
  backend: Backend;
  apiKey: string;
}

function selectBackend(): BackendSelection | { backend: "none"; reason: string } {
  const override = process.env.CHOVY_WEBSEARCH_BACKEND?.trim().toLowerCase();
  if (override === "tavily") {
    const apiKey = getTavilyKey();
    if (apiKey) return { backend: "tavily", apiKey };
    return { backend: "none", reason: "CHOVY_WEBSEARCH_BACKEND=tavily but TAVILY_API_KEY is not set" };
  }
  if (override === "brave") {
    const apiKey = getBraveKey();
    if (apiKey) return { backend: "brave", apiKey };
    return { backend: "none", reason: "CHOVY_WEBSEARCH_BACKEND=brave but BRAVE_API_KEY is not set" };
  }
  const tavily = getTavilyKey();
  if (tavily) return { backend: "tavily", apiKey: tavily };
  const brave = getBraveKey();
  if (brave) return { backend: "brave", apiKey: brave };
  return {
    backend: "none",
    reason:
      "No search backend configured. Set TAVILY_API_KEY or BRAVE_API_KEY " +
      "(env or ~/.chovy/secrets/{tavily,brave}).",
  };
}

// ── Result shape ──────────────────────────────────────────────────────────

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

// ── Backend: Tavily ───────────────────────────────────────────────────────

interface TavilyResultRaw {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_domains: allowedDomains?.length ? allowedDomains : undefined,
      exclude_domains: blockedDomains?.length ? blockedDomains : undefined,
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Tavily ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
  }
  const body = (await res.json()) as { results?: TavilyResultRaw[] };
  return (body.results ?? [])
    .map((r) => normalize(r.title, r.url, r.content))
    .filter((h): h is SearchHit => h !== null);
}

// ── Backend: Brave ────────────────────────────────────────────────────────

interface BraveResultRaw {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

function applyDomainFiltersToQuery(
  query: string,
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): string {
  const allowedClause = allowed?.length
    ? `(${allowed.map((d) => `site:${d}`).join(" OR ")}) `
    : "";
  const blockedClause = blocked?.length
    ? `${blocked.map((d) => `-site:${d}`).join(" ")} `
    : "";
  return `${allowedClause}${blockedClause}${query}`.trim();
}

async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", applyDomainFiltersToQuery(query, allowedDomains, blockedDomains));
  url.searchParams.set("count", String(maxResults));
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brave ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
  }
  const body = (await res.json()) as {
    web?: { results?: BraveResultRaw[] };
  };
  return (body.web?.results ?? [])
    .map((r) => normalize(r.title, r.url, r.description))
    .filter((h): h is SearchHit => h !== null);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function normalize(title: unknown, url: unknown, snippet: unknown): SearchHit | null {
  if (typeof title !== "string" || typeof url !== "string") return null;
  return {
    title: title.trim(),
    url: url.trim(),
    snippet: typeof snippet === "string" ? snippet.trim() : "",
  };
}

function renderMarkdown(query: string, backend: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `Web search for "${query}" via ${backend}: no results.`;
  }
  const lines: string[] = [`Web search results for "${query}" via ${backend}:`, ""];
  hits.forEach((hit, i) => {
    lines.push(`${i + 1}. **${hit.title}** — ${hit.url}`);
    if (hit.snippet) {
      lines.push(`   ${hit.snippet}`);
    }
    lines.push("");
  });
  lines.push("REMINDER: cite sources in your response using markdown links.");
  return lines.join("\n");
}

// ── Tool ──────────────────────────────────────────────────────────────────

const argsSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe("The search query."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(HARD_MAX_RESULTS)
    .optional()
    .describe(`Maximum number of results (default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS}).`),
  allowedDomains: z
    .array(z.string())
    .optional()
    .describe("Restrict results to these domains."),
  blockedDomains: z
    .array(z.string())
    .optional()
    .describe("Never return results from these domains."),
});

type Args = z.infer<typeof argsSchema>;

export const webSearchTool: Tool<typeof argsSchema> = {
  name: "web_search",
  version: 2,
  family: "web",

  isReadOnly: true,
  canUseWithoutAsk: false, // outbound query is a privacy event; ask first.

  desc: {
    lean:
      "Search the web via Tavily / Brave and return {title, url, snippet} hits.",
    full:
      "Run a web search via an external backend (Tavily or Brave) and return\n" +
      "structured results. Backend selection order:\n\n" +
      "  1. `CHOVY_WEBSEARCH_BACKEND=tavily|brave` override\n" +
      "  2. `TAVILY_API_KEY` (env or ~/.chovy/secrets/tavily) → Tavily\n" +
      "  3. `BRAVE_API_KEY`  (env or ~/.chovy/secrets/brave)  → Brave\n" +
      "  4. Otherwise the tool refuses with a setup hint.\n\n" +
      "- `maxResults` defaults to 5, hard cap 20.\n" +
      "- `allowedDomains` / `blockedDomains` filter results (cannot be set\n" +
      "  together for Tavily; Brave folds them into `site:` operators).\n" +
      "- Results include `title`, `url`, and `snippet`. Cite URLs in the\n" +
      "  final answer using markdown links.\n" +
      "- 30s timeout per call; no cookies or auth headers are forwarded.",
    examples: [
      `web_search({ query: "Bun + Ink hot reload", maxResults: 5 })`,
      `web_search({ query: "Tavily API docs", allowedDomains: ["tavily.com"] })`,
    ],
  },

  fullTriggers: [
    /\b(search|google|bing|find\s+online|look\s+up|web\s+search)\b/i,
    /(搜索|搜一下|查一下|查一查|搜网|搜网页)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    return `Web search: ${args.query.slice(0, 60)}${args.query.length > 60 ? "…" : ""}`;
  },

  checkPermissions(args): PermissionPreflight {
    if (args.allowedDomains?.length && args.blockedDomains?.length) {
      return {
        outcome: "deny",
        reason: "allowedDomains and blockedDomains cannot both be set",
        matchedRule: "WebSearch(conflicting-filters)",
      };
    }
    const sel = selectBackend();
    if (sel.backend === "none") {
      return {
        outcome: "deny",
        reason: sel.reason,
        matchedRule: "WebSearch(no-backend)",
      };
    }
    return {
      outcome: "ask",
      reason: `web search via ${sel.backend}`,
      matchedRule: `WebSearch(backend:${sel.backend})`,
    };
  },

  async run(args: Args, ctx): Promise<ToolResult> {
    const t0 = Date.now();
    const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;

    if (args.allowedDomains?.length && args.blockedDomains?.length) {
      return {
        ok: false,
        content:
          "Error: allowedDomains and blockedDomains cannot both be specified " +
          "in the same request.",
        errorCode: "TOOL_INVALID_ARGS",
        meta: { durMs: Date.now() - t0 },
      };
    }

    const sel = selectBackend();
    if (sel.backend === "none") {
      return {
        ok: false,
        content: `Error: ${sel.reason}`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }

    // Compose signal: per-call timeout + caller abort.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("search timeout")), SEARCH_TIMEOUT_MS);
    const upstream = ctx?.abortSignal;
    const onAbort = () => ac.abort(upstream?.reason);
    upstream?.addEventListener("abort", onAbort);

    try {
      let hits: SearchHit[];
      if (sel.backend === "tavily") {
        hits = await searchTavily(
          args.query,
          maxResults,
          sel.apiKey,
          ac.signal,
          args.allowedDomains,
          args.blockedDomains,
        );
      } else {
        hits = await searchBrave(
          args.query,
          maxResults,
          sel.apiKey,
          ac.signal,
          args.allowedDomains,
          args.blockedDomains,
        );
      }

      const markdown = renderMarkdown(args.query, sel.backend, hits);
      return {
        ok: true,
        content: markdown,
        structuredOutput: {
          kind: "search",
          query: args.query,
          backend: sel.backend,
          count: hits.length,
          hits,
        },
        meta: {
          durMs: Date.now() - t0,
          cmd: `${sel.backend}:search(${args.query})`,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("web_search: backend error", {
        backend: sel.backend,
        error: msg,
      });
      return {
        ok: false,
        content: `web_search via ${sel.backend} failed: ${msg}`,
        errorCode: "INTERNAL",
        meta: {
          durMs: Date.now() - t0,
          cmd: `${sel.backend}:search(${args.query})`,
        },
      };
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onAbort);
    }
  },
};
