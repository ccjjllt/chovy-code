/**
 * `web_fetch` — Tool Protocol v2 fetcher + secondary-model summarizer (step-10).
 *
 * Per `docs/step-10-web-tools.md §2`:
 *
 *   1. `fetch(url)` with the credentials-free posture
 *      (no `Cookie`, no `Authorization`, no `credentials: include`).
 *   2. `http://` is rewritten to `https://` before the request goes out.
 *   3. Redirects are NOT auto-followed: same-host (with `www.` wobble)
 *      hops are walked transparently, but the first cross-host hop is
 *      surfaced back to the model with the new URL so the model can decide
 *      whether to call us again.
 *   4. `text/html` is converted to markdown via `./htmlToMd.ts` (no
 *      `turndown` dependency — see that file for the rationale). `text/*`
 *      passes through verbatim; other MIME types are rejected with a
 *      clear "binary content" message.
 *   5. The markdown + the user's `prompt` are fed to a small model via
 *      `./smallModel.ts`. When no small-model API key is reachable the
 *      helper degrades to a deterministic heuristic so the agent loop
 *      never hangs on environmental gaps.
 *   6. 15-minute per-URL cache; first cache miss for the URL pays the
 *      fetch + markdown conversion cost, subsequent hits skip both.
 *
 * Privacy / safety:
 *   - `validateUrl` rejects private IP literals (10/8, 127/8, 172.16/12,
 *     192.168/16, localhost, ::1, link-local fe80::/10) and refuses URLs
 *     with embedded credentials. `CHOVY_WEBFETCH_ALLOW_PRIVATE=1` unsets
 *     the network gate for users running internal docs / dev mirrors.
 *   - `User-Agent` is a static string identifying chovy-code so we do not
 *     impersonate a browser; some sites refuse empty UAs entirely.
 *   - Body cap is 10 MiB to keep a malicious server from blowing the
 *     event loop or starving the small-model prompt budget.
 *   - `redirect: "manual"` keeps us in charge of every hop.
 */

import { isIP } from "node:net";
import { z } from "zod";

import { logger } from "../../logger/index.js";
import { emitTelemetry } from "../../telemetry/index.js";
import type {
  PermissionPreflight,
  Tool,
  ToolResult,
} from "../../types/index.js";

import { htmlToMd } from "./htmlToMd.js";
import { summarizeWithSmallModel } from "./smallModel.js";

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min, per spec
const CACHE_MAX_ENTRIES = 64;        // simple soft cap; LRU eviction
const FETCH_TIMEOUT_MS = 60_000;     // 60s — same as cc-haha
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_URL_LENGTH = 2000;
const MAX_REDIRECTS = 10;
const USER_AGENT = "chovy-code/0.1 (+https://github.com/local/chovy-code)";

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  ts: number;
  bytes: number;
  contentType: string;
  status: number;
  statusText: string;
  finalUrl: string;
  /** Already converted to markdown / text. */
  markdown: string;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(url: string): CacheEntry | undefined {
  const e = cache.get(url);
  if (!e) return undefined;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    cache.delete(url);
    return undefined;
  }
  return e;
}

function cacheSet(url: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest insertion. Map iteration order is insertion order.
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(url, entry);
}

/** Testing / `/web cache clear` helper. */
export function clearWebFetchCache(): void {
  cache.clear();
}

// ── URL validation ────────────────────────────────────────────────────────

function isPrivateIPv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const parts = hostname.split(".").map((s) => Number.parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  // node:net's `isIP` returns 6 for valid v6; we accept brackets via the URL
  // parser, so by the time we get here the brackets are already stripped.
  if (isIP(hostname) !== 6) return false;
  const lower = hostname.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (h === "localhost.localdomain") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  // .internal / .lan are common enterprise suffixes.
  if (h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".intranet")) {
    return true;
  }
  if (isPrivateIPv4(h)) return true;
  if (isPrivateIPv6(h)) return true;
  return false;
}

interface ValidationOk {
  ok: true;
  url: URL;
  upgraded: boolean;
}
interface ValidationFail {
  ok: false;
  reason: string;
}

function allowPrivate(): boolean {
  const v = process.env.CHOVY_WEBFETCH_ALLOW_PRIVATE;
  return v === "1" || v?.toLowerCase() === "true";
}

function validateUrl(raw: string): ValidationOk | ValidationFail {
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds ${MAX_URL_LENGTH} chars` };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `invalid URL: ${raw}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with embedded credentials are refused" };
  }
  let upgraded = false;
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
    upgraded = true;
  } else if (parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme: ${parsed.protocol}` };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, reason: "URL has no host" };
  if (!allowPrivate() && isPrivateHost(host)) {
    return {
      ok: false,
      reason:
        `private / loopback host refused: ${host}. ` +
        `Set CHOVY_WEBFETCH_ALLOW_PRIVATE=1 to override.`,
    };
  }
  return { ok: true, url: parsed, upgraded };
}

// ── Redirect classification ───────────────────────────────────────────────

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Same-host hops (including a `www.` wobble) and same-scheme, same-port
 * URLs are walked through transparently. Anything else is surfaced to the
 * model so the user / model can decide whether to make a new call. This is
 * the same rule cc-haha uses (`isPermittedRedirect`).
 */
function isSameSiteRedirect(from: URL, to: URL): boolean {
  if (from.protocol !== to.protocol) return false;
  if (from.port !== to.port) return false;
  if (to.username || to.password) return false;
  return stripWww(from.hostname) === stripWww(to.hostname);
}

// ── Fetch with manual redirect handling ───────────────────────────────────

interface RedirectOut {
  kind: "redirect";
  originalUrl: string;
  redirectUrl: string;
  status: number;
}

interface FetchOk {
  kind: "ok";
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  body: string;
}

async function fetchWithRedirects(
  startUrl: URL,
  signal: AbortSignal,
): Promise<FetchOk | RedirectOut> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      // No `credentials` — `fetch` defaults to "same-origin" which equates
      // to no cookies for cross-origin requests; we explicitly avoid the
      // "include" mode and never set Cookie / Authorization headers.
      headers: {
        Accept: "text/markdown, text/html, text/*, application/xhtml+xml;q=0.9, */*;q=0.1",
        "Accept-Language": "en,zh;q=0.9",
        "User-Agent": USER_AGENT,
      },
      signal,
    });

    // 3xx — handle manually.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return {
          kind: "ok",
          finalUrl: current.toString(),
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get("content-type") ?? "",
          bytes: 0,
          body: "",
        };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          kind: "ok",
          finalUrl: current.toString(),
          status: res.status,
          statusText: `invalid Location header: ${location}`,
          contentType: "",
          bytes: 0,
          body: "",
        };
      }
      if (next.protocol === "http:") next.protocol = "https:";

      if (!isSameSiteRedirect(current, next)) {
        return {
          kind: "redirect",
          originalUrl: current.toString(),
          redirectUrl: next.toString(),
          status: res.status,
        };
      }
      current = next;
      continue;
    }

    // Non-redirect — pull the body up to MAX_BODY_BYTES.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_BODY_BYTES) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            return {
              kind: "ok",
              finalUrl: current.toString(),
              status: res.status,
              statusText: `body exceeds ${MAX_BODY_BYTES} bytes`,
              contentType: res.headers.get("content-type") ?? "",
              bytes: total,
              body: "",
            };
          }
          chunks.push(value);
        }
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    return {
      kind: "ok",
      finalUrl: current.toString(),
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type") ?? "",
      bytes: buf.length,
      body: buf.toString("utf-8"),
    };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

// ── MIME handling ─────────────────────────────────────────────────────────

function isTextLike(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return true;
  if (ct.includes("xhtml")) return true;
  if (ct.includes("json") || ct.includes("xml")) return true;
  if (ct.includes("javascript") || ct.includes("ecmascript")) return true;
  return false;
}

function isHtml(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("xhtml");
}

// ── Tool ──────────────────────────────────────────────────────────────────

const argsSchema = z.object({
  url: z
    .string()
    .url()
    .describe("The URL to fetch. HTTP is upgraded to HTTPS automatically."),
  prompt: z
    .string()
    .min(1)
    .describe("The question / extraction target to run against the fetched page."),
});

type Args = z.infer<typeof argsSchema>;

export const webFetchTool: Tool<typeof argsSchema> = {
  name: "web_fetch",
  version: 2,
  family: "web",

  isReadOnly: true,
  canUseWithoutAsk: false, // network calls leak request metadata; ask first.

  desc: {
    lean:
      "Fetch a URL, convert HTML to markdown, and answer `prompt` against it " +
      "via a small fast model. HTTP→HTTPS; private hosts refused.",
    full:
      "Fetches a URL and answers `prompt` against the returned content.\n\n" +
      "- HTTP is upgraded to HTTPS automatically.\n" +
      "- Cross-host redirects are NOT auto-followed; the new URL is returned\n" +
      "  to the model so it can call again with the redirect target.\n" +
      "- Same-host redirects (including a `www.` wobble) are walked\n" +
      "  transparently up to 10 hops.\n" +
      "- `text/html` is converted to markdown; `text/*` passes through;\n" +
      "  binary content (PDF, images, archives) is rejected with a hint.\n" +
      "- Results are cached per URL for 15 minutes.\n" +
      "- Private / loopback hosts (10/8, 127/8, 172.16/12, 192.168/16,\n" +
      "  localhost, ::1, .local, .internal) are refused. Set\n" +
      "  `CHOVY_WEBFETCH_ALLOW_PRIVATE=1` to override.\n" +
      "- No cookies / Authorization headers are sent.\n" +
      "- For authenticated services (Google Docs, Jira, GitHub private repos)\n" +
      "  use an authenticated MCP tool or the `bash` + `gh` CLI instead.",
    examples: [
      `web_fetch({ url: "https://example.com", prompt: "Summarize this page." })`,
      `web_fetch({ url: "https://news.ycombinator.com", prompt: "List the top 5 story titles." })`,
    ],
  },

  fullTriggers: [
    /\b(fetch|download|http|https|url|website|web\s*page|webpage|article|browse)\b/i,
    /(抓取|下载|网页|网站|访问|爬|链接|文章|新闻)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    try {
      const host = new URL(args.url).hostname;
      return `Fetch ${host}`;
    } catch {
      return "Fetch URL";
    }
  },

  checkPermissions(args): PermissionPreflight {
    const v = validateUrl(args.url);
    if (!v.ok) {
      return { outcome: "deny", reason: v.reason, matchedRule: "WebFetch(invalid-url)" };
    }
    // Network egress always asks once per session; the engine (step-12) is
    // expected to remember per-host allow rules from this turn forward.
    return {
      outcome: "ask",
      reason: `network fetch to ${v.url.hostname}`,
      matchedRule: `WebFetch(domain:${v.url.hostname})`,
    };
  },

  async run(args: Args, ctx): Promise<ToolResult> {
    const t0 = Date.now();

    const v = validateUrl(args.url);
    if (!v.ok) {
      return {
        ok: false,
        content: `Error: ${v.reason}`,
        errorCode: "TOOL_DENIED",
        meta: { durMs: Date.now() - t0 },
      };
    }
    const upgradedUrl = v.url.toString();

    // Cache hit: skip both the fetch and the HTML→MD pass.
    const cached = cacheGet(args.url) ?? cacheGet(upgradedUrl);
    let entry = cached;

    if (!entry) {
      // Build an AbortSignal that respects both the per-call timeout and
      // the caller-provided signal (when ctx is wired by the agent loop).
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("fetch timeout")), FETCH_TIMEOUT_MS);
      const upstreamSignal = ctx?.abortSignal;
      const onAbort = () => ac.abort(upstreamSignal?.reason);
      upstreamSignal?.addEventListener("abort", onAbort);

      let fetchRes: FetchOk | RedirectOut;
      try {
        fetchRes = await fetchWithRedirects(v.url, ac.signal);
      } catch (err) {
        clearTimeout(timer);
        upstreamSignal?.removeEventListener("abort", onAbort);
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("web_fetch: network error", { url: upgradedUrl, error: msg });
        emitTelemetry({ type: "tool.call", tool: "web_fetch", ok: false, durMs: Date.now() - t0 });
        return {
          ok: false,
          content: `Network error fetching ${upgradedUrl}: ${msg}`,
          errorCode: "INTERNAL",
          meta: { durMs: Date.now() - t0, cmd: `GET ${upgradedUrl}` },
        };
      } finally {
        clearTimeout(timer);
        upstreamSignal?.removeEventListener("abort", onAbort);
      }

      // Cross-host redirect: hand the new URL back to the model. No cache
      // entry — the redirect target might already be cached separately.
      if (fetchRes.kind === "redirect") {
        const statusText =
          fetchRes.status === 301 ? "Moved Permanently"
            : fetchRes.status === 308 ? "Permanent Redirect"
            : fetchRes.status === 307 ? "Temporary Redirect"
            : "Found";
        const body =
          `REDIRECT DETECTED: cross-host hop is not auto-followed.\n\n` +
          `Original URL: ${fetchRes.originalUrl}\n` +
          `Redirect URL: ${fetchRes.redirectUrl}\n` +
          `Status: ${fetchRes.status} ${statusText}\n\n` +
          `Call web_fetch again with:\n` +
          `  url: "${fetchRes.redirectUrl}"\n` +
          `  prompt: "${args.prompt.replace(/"/g, '\\"')}"`;
        emitTelemetry({ type: "tool.call", tool: "web_fetch", ok: true, durMs: Date.now() - t0 });
        return {
          ok: true,
          content: body,
          structuredOutput: {
            kind: "redirect",
            originalUrl: fetchRes.originalUrl,
            redirectUrl: fetchRes.redirectUrl,
            status: fetchRes.status,
          },
          meta: { durMs: Date.now() - t0, cmd: `GET ${upgradedUrl}` },
        };
      }

      // Non-OK status — surface body if it looks textual, otherwise just
      // the status line. We deliberately do not cache failures.
      if (fetchRes.status >= 400) {
        const msg = `HTTP ${fetchRes.status} ${fetchRes.statusText} for ${fetchRes.finalUrl}`;
        emitTelemetry({ type: "tool.call", tool: "web_fetch", ok: false, durMs: Date.now() - t0 });
        return {
          ok: false,
          content: msg,
          errorCode: "INTERNAL",
          structuredOutput: {
            kind: "http-error",
            status: fetchRes.status,
            statusText: fetchRes.statusText,
            url: fetchRes.finalUrl,
          },
          meta: {
            durMs: Date.now() - t0,
            cmd: `GET ${upgradedUrl}`,
            bytes: fetchRes.bytes,
          },
        };
      }

      // Binary / unsupported MIME — refuse with a hint.
      if (!isTextLike(fetchRes.contentType)) {
        emitTelemetry({ type: "tool.call", tool: "web_fetch", ok: false, durMs: Date.now() - t0 });
        return {
          ok: false,
          content:
            `Refused: unsupported content-type "${fetchRes.contentType || "unknown"}" ` +
            `for ${fetchRes.finalUrl}. web_fetch only handles text/* responses.`,
          errorCode: "TOOL_DENIED",
          structuredOutput: {
            kind: "binary-content",
            contentType: fetchRes.contentType,
            bytes: fetchRes.bytes,
            url: fetchRes.finalUrl,
          },
          meta: {
            durMs: Date.now() - t0,
            cmd: `GET ${upgradedUrl}`,
            bytes: fetchRes.bytes,
          },
        };
      }

      // Convert to markdown.
      const markdown = isHtml(fetchRes.contentType)
        ? htmlToMd(fetchRes.body)
        : fetchRes.body;

      entry = {
        ts: Date.now(),
        bytes: fetchRes.bytes,
        contentType: fetchRes.contentType,
        status: fetchRes.status,
        statusText: fetchRes.statusText,
        finalUrl: fetchRes.finalUrl,
        markdown,
      };
      cacheSet(args.url, entry);
    }

    // Always run the prompt through the small-model summarizer — even on
    // cache hits — because different prompts against the same cached
    // markdown legitimately yield different answers.
    const summary = await summarizeWithSmallModel({
      content: entry.markdown,
      prompt: args.prompt,
      signal: ctx?.abortSignal,
    });

    emitTelemetry({ type: "tool.call", tool: "web_fetch", ok: true, durMs: Date.now() - t0 });

    return {
      ok: true,
      content: summary.text,
      structuredOutput: {
        kind: "fetched",
        url: entry.finalUrl,
        contentType: entry.contentType,
        status: entry.status,
        markdownBytes: entry.markdown.length,
        bodyBytes: entry.bytes,
        cached: cached !== undefined,
        summarizer: summary.source,
      },
      meta: {
        durMs: Date.now() - t0,
        cmd: `GET ${entry.finalUrl}`,
        bytes: entry.bytes,
      },
    };
  },
};
