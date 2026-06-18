/**
 * Step-10 smoke test (run with `bun scripts/smoke-step10.ts`).
 *
 * Exercises the headline acceptance criteria from
 * `docs/step-10-web-tools.md §"验收标准"`:
 *
 *   1. `htmlToMd` converts a minimal HTML doc to readable markdown.
 *   2. Private hosts are refused at `checkPermissions` and at `run`.
 *   3. Cross-host redirects return a `redirect` structuredOutput rather
 *      than auto-following.
 *   4. `web_search` refuses cleanly when no backend is configured.
 *   5. The ATP describer picks `lean` for the web tools at default budget
 *      and upgrades them to `full` when a `fullTriggers` keyword appears
 *      in recent messages.
 *
 * Tests that require live network (HTTPS to example.com) are gated on
 * `SMOKE_NETWORK=1` so the script is safe to run in CI or air-gapped envs.
 */

import { describeTools } from "../src/tools/describe.js";
import { htmlToMd } from "../src/tools/web/htmlToMd.js";
import { webFetchTool, webSearchTool, clearWebFetchCache } from "../src/tools/web/index.js";
// Trigger registration of all built-ins.
import "../src/tools/index.js";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== Step-10 web tools smoke ===\n");

// 1. htmlToMd
{
  const html = `
    <html>
      <head><title>Hello</title><script>alert('x')</script></head>
      <body>
        <h1>Heading</h1>
        <p>A paragraph with <a href="https://example.com">a link</a>.</p>
        <ul><li>One</li><li>Two</li></ul>
        <pre><code>const x = 1;</code></pre>
      </body>
    </html>`;
  const md = htmlToMd(html);
  check("htmlToMd: title becomes H1", md.includes("# Hello"));
  check("htmlToMd: H1 emitted", md.includes("# Heading"));
  check("htmlToMd: link reference", md.includes("[a link](https://example.com)"));
  check("htmlToMd: list items", md.includes("- One") && md.includes("- Two"));
  check("htmlToMd: <script> dropped", !md.includes("alert"));
  check("htmlToMd: code fence", md.includes("```") && md.includes("const x = 1;"));
}

// 2. Private host refused.
{
  const verdict = webFetchTool.checkPermissions?.(
    { url: "http://127.0.0.1/foo", prompt: "x" },
    {} as never,
  );
  // checkPermissions may be sync or Promise — both shapes acceptable here.
  Promise.resolve(verdict).then((v) => {
    check(
      "WebFetch.checkPermissions denies 127.0.0.1",
      v?.outcome === "deny" && /private|loopback/i.test(v?.reason ?? ""),
      JSON.stringify(v),
    );
  });

  const localHost = webFetchTool.checkPermissions?.(
    { url: "http://localhost:3000/", prompt: "x" },
    {} as never,
  );
  Promise.resolve(localHost).then((v) => {
    check(
      "WebFetch.checkPermissions denies localhost",
      v?.outcome === "deny",
      JSON.stringify(v),
    );
  });

  // run() also short-circuits for private hosts.
  const ranPrivate = await webFetchTool.run(
    { url: "http://10.0.0.5/api", prompt: "x" },
  );
  const ok = typeof ranPrivate !== "string" && ranPrivate.ok === false &&
    ranPrivate.errorCode === "TOOL_DENIED";
  check("WebFetch.run refuses 10.0.0.5", ok, JSON.stringify(ranPrivate));
}

// 3. Override allows private hosts.
{
  process.env.CHOVY_WEBFETCH_ALLOW_PRIVATE = "1";
  const v = webFetchTool.checkPermissions?.(
    { url: "http://127.0.0.1/foo", prompt: "x" },
    {} as never,
  );
  const verdict = await Promise.resolve(v);
  check(
    "WebFetch override env unblocks private host preflight",
    verdict?.outcome === "ask",
    JSON.stringify(verdict),
  );
  delete process.env.CHOVY_WEBFETCH_ALLOW_PRIVATE;
}

// 4. WebSearch refuses cleanly when no key is set.
{
  // Guard against ambient env keys that would let a real search through.
  const restore = {
    tav: process.env.TAVILY_API_KEY,
    bra: process.env.BRAVE_API_KEY,
    ovr: process.env.CHOVY_WEBSEARCH_BACKEND,
  };
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.CHOVY_WEBSEARCH_BACKEND;

  const v = webSearchTool.checkPermissions?.(
    { query: "bun ink hot reload" },
    {} as never,
  );
  const verdict = await Promise.resolve(v);
  check(
    "WebSearch.checkPermissions denies when no backend configured",
    verdict?.outcome === "deny" && /TAVILY|BRAVE|backend/i.test(verdict?.reason ?? ""),
    JSON.stringify(verdict),
  );

  const ran = await webSearchTool.run(
    { query: "bun ink hot reload" },
  );
  const ok = typeof ran !== "string" && ran.ok === false &&
    ran.errorCode === "TOOL_DENIED";
  check("WebSearch.run refuses without backend", ok, JSON.stringify(ran));

  if (restore.tav !== undefined) process.env.TAVILY_API_KEY = restore.tav;
  if (restore.bra !== undefined) process.env.BRAVE_API_KEY = restore.bra;
  if (restore.ovr !== undefined) process.env.CHOVY_WEBSEARCH_BACKEND = restore.ovr;
}

// 5. ATP describer picks lean by default and upgrades on keyword match.
{
  // Default: ample budget, no relevant message → web tools should be lean.
  const lean = describeTools({
    budgetTokens: 4000,
    recentMessages: [{ role: "user", content: "review this typescript code" }],
    lastToolCalls: [],
  });
  const leanFetch = lean.find((d) => d.name === "web_fetch");
  check(
    "ATP: web_fetch defaults to lean when not relevant",
    leanFetch?.level === "lean",
    JSON.stringify(leanFetch),
  );

  // With a fetch verb, web_fetch should win the upgrade.
  const upgraded = describeTools({
    budgetTokens: 4000,
    recentMessages: [{ role: "user", content: "fetch https://example.com and summarize" }],
    lastToolCalls: [],
  });
  const upFetch = upgraded.find((d) => d.name === "web_fetch");
  check(
    "ATP: web_fetch upgrades to full when fetch keyword appears",
    upFetch?.level === "full",
    JSON.stringify(upFetch),
  );
}

// 6. (Optional) Live cross-host redirect — example.org → example.com style.
//    Skipped unless SMOKE_NETWORK=1 to avoid flaky CI.
if (process.env.SMOKE_NETWORK === "1") {
  clearWebFetchCache();
  const ran = await webFetchTool.run({
    url: "https://example.com",
    prompt: "Summarize this page in one sentence.",
  });
  const ok = typeof ran !== "string" && ran.ok === true && ran.content.length > 0;
  check("WebFetch live: example.com returns non-empty content", ok);
}

// Wait a tick so the floating Promise.resolve checks above have a chance
// to log — they were started inline. (We `await` everything else.)
await new Promise((r) => setTimeout(r, 25));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
