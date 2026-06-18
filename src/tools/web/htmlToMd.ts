/**
 * Minimal HTML → Markdown converter (step-10).
 *
 * `docs/step-10-web-tools.md §risks` allows a "head + body + lists" first
 * pass. We deliberately do NOT pull in `turndown` (cc-haha uses it but it
 * drags @mixmark-io/domino — ~1.4MB of JSDOM-ish runtime — for every web
 * fetch); a focused regex/state-machine pass covers the common semantic
 * tags Claude / GLM actually need.
 *
 * What we support:
 *   - `<title>` / `<h1>`–`<h6>` → `#` headings
 *   - `<p>`                     → blank-line-separated paragraph
 *   - `<br>`                    → hard line break
 *   - `<a href="...">`          → `[text](href)`
 *   - `<img src alt>`           → `![alt](src)`
 *   - `<strong>` / `<b>`        → `**text**`
 *   - `<em>` / `<i>`            → `*text*`
 *   - `<code>` (inline)         → `` `text` ``
 *   - `<pre>` / `<pre><code>`   → fenced ``` block
 *   - `<ul>` / `<ol>` / `<li>`  → `-` / `1.` lists (nested)
 *   - `<blockquote>`            → `> ` prefix
 *   - `<hr>`                    → `---`
 *
 * What we drop:
 *   - `<script>`, `<style>`, `<noscript>`, `<iframe>`, `<svg>` (entire
 *     subtree, including children) — they are pure noise for an LLM.
 *   - `<head>` siblings other than `<title>` (meta / link / script).
 *   - All other tags collapse to their text content.
 *
 * Robustness:
 *   - Works on partial / malformed HTML (the wild web). We tokenize, never
 *     build a DOM, and treat unclosed tags as a stream of text-with-format.
 *   - Decodes the standard named entities + numeric / hex (`&#39;`,
 *     `&#x27;`) — enough to cover most real pages without pulling in a
 *     full HTML5 entities table.
 *
 * Output is whitespace-normalized: collapses runs of >2 blank lines so the
 * markdown doesn't bloat the secondary-model prompt budget.
 */

// ── Entity decoding ────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (_m, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return "";
        }
      }
      return "";
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? `&${body};`;
  });
}

// ── Pre-processing: strip subtrees we never want ───────────────────────────

const DROP_SUBTREES = ["script", "style", "noscript", "iframe", "svg"];

function stripDroppedSubtrees(html: string): string {
  let out = html;
  for (const tag of DROP_SUBTREES) {
    // Non-greedy match `<tag ...>...</tag>`. `[\s\S]` to cross line breaks;
    // case-insensitive because pages in the wild are inconsistent.
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    out = out.replace(re, "");
    // Self-closing or never-closed variants — drop the opening tag too so
    // it doesn't leak into text output.
    const open = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    out = out.replace(open, "");
  }
  // Strip HTML comments wholesale — they're never useful to the model and
  // some sites embed huge build-tool comments.
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  return out;
}

// ── Attribute parsing (cheap; only what we need) ──────────────────────────

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

// ── Tokenizer ─────────────────────────────────────────────────────────────

type Token =
  | { kind: "text"; text: string }
  | { kind: "open"; tag: string; raw: string; selfClose: boolean }
  | { kind: "close"; tag: string };

function tokenize(html: string): Token[] {
  const out: Token[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > i) {
      out.push({ kind: "text", text: html.slice(i, m.index) });
    }
    const whole = m[0]!;
    const tag = m[1]!.toLowerCase();
    const tail = m[2] ?? "";
    if (whole.startsWith("</")) {
      out.push({ kind: "close", tag });
    } else {
      const selfClose = /\/\s*>$/.test(whole) || VOID_TAGS.has(tag);
      out.push({ kind: "open", tag, raw: whole, selfClose });
      void tail;
    }
    i = re.lastIndex;
  }
  if (i < html.length) {
    out.push({ kind: "text", text: html.slice(i) });
  }
  return out;
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

// ── Renderer ──────────────────────────────────────────────────────────────

interface ListFrame {
  kind: "ul" | "ol";
  index: number;
}

interface RenderState {
  out: string[];
  listStack: ListFrame[];
  /** Each entry is one ancestor whose text should be collapsed to one line. */
  inPre: number;
  inCode: number;
  inBlockquote: number;
  /** Suppress emitted text (e.g. inside <head> we keep only <title>). */
  inHead: number;
  inTitleEmitted: boolean;
  /** Accumulate inline link/image so we can drop unbalanced bits. */
  hrefStack: (string | undefined)[];
  /** Buffer for <a> content; we only emit when the closing tag fires. */
  anchorBuf: string | null;
}

function newState(): RenderState {
  return {
    out: [],
    listStack: [],
    inPre: 0,
    inCode: 0,
    inBlockquote: 0,
    inHead: 0,
    inTitleEmitted: false,
    hrefStack: [],
    anchorBuf: null,
  };
}

function listIndent(s: RenderState): string {
  // Two spaces per nesting level (CommonMark loose-list compatible).
  return "  ".repeat(Math.max(0, s.listStack.length - 1));
}

function pushBlock(s: RenderState, line: string): void {
  // Block-level: ensure preceding blank line unless we're at the very start.
  if (s.out.length > 0 && s.out[s.out.length - 1] !== "") {
    s.out.push("");
  }
  s.out.push(line);
}

function pushLine(s: RenderState, line: string): void {
  s.out.push(line);
}

function appendInline(s: RenderState, text: string): void {
  if (text === "") return;
  if (s.anchorBuf !== null) {
    s.anchorBuf += text;
    return;
  }
  if (s.out.length === 0) {
    s.out.push(text);
    return;
  }
  s.out[s.out.length - 1] = (s.out[s.out.length - 1] ?? "") + text;
}

function normalizeText(s: RenderState, raw: string): string {
  const decoded = decodeEntities(raw);
  if (s.inPre > 0) return decoded;
  // Collapse internal whitespace runs to single spaces; keep leading
  // space if present so word boundaries survive.
  return decoded.replace(/[\t\n\r ]+/g, " ");
}

export interface HtmlToMdOptions {
  /** Hard cap on output characters. Default 200 000. */
  maxChars?: number;
}

export function htmlToMd(html: string, opts: HtmlToMdOptions = {}): string {
  const maxChars = opts.maxChars ?? 200_000;
  const cleaned = stripDroppedSubtrees(html);
  const tokens = tokenize(cleaned);
  const s = newState();

  // Seed an empty line so `appendInline` has a buffer to append into.
  s.out.push("");

  for (const tok of tokens) {
    if (tok.kind === "text") {
      const txt = normalizeText(s, tok.text);
      if (s.inHead > 0 && !s.inTitleEmitted) continue;
      appendInline(s, txt);
      continue;
    }

    if (tok.kind === "open") {
      const tag = tok.tag;

      if (tag === "head") { s.inHead++; continue; }
      if (tag === "body") continue;
      if (tag === "html") continue;
      if (tag === "title") {
        // Emit as H1 once we close.
        s.inHead = Math.max(s.inHead, 1); // make sure we're treated as head
        s.inTitleEmitted = true;
        pushBlock(s, "# ");
        continue;
      }

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        pushBlock(s, "#".repeat(level) + " ");
        continue;
      }

      if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "main" || tag === "header" || tag === "footer" || tag === "nav") {
        pushBlock(s, "");
        continue;
      }

      if (tag === "br") {
        appendInline(s, "  \n");
        continue;
      }

      if (tag === "hr") {
        pushBlock(s, "---");
        pushLine(s, "");
        continue;
      }

      if (tag === "ul" || tag === "ol") {
        // CommonMark wants a blank line before a list at top-level only.
        if (s.listStack.length === 0) pushBlock(s, "");
        s.listStack.push({ kind: tag, index: 0 });
        continue;
      }

      if (tag === "li") {
        const frame = s.listStack[s.listStack.length - 1];
        if (!frame) {
          // Stray <li> without a list — treat as `-` bullet.
          pushLine(s, "- ");
        } else {
          frame.index += 1;
          const marker = frame.kind === "ol" ? `${frame.index}. ` : "- ";
          pushLine(s, listIndent(s) + marker);
        }
        continue;
      }

      if (tag === "blockquote") {
        s.inBlockquote++;
        pushBlock(s, "> ");
        continue;
      }

      if (tag === "pre") {
        s.inPre++;
        pushBlock(s, "```");
        pushLine(s, "");
        continue;
      }

      if (tag === "code") {
        if (s.inPre > 0) continue; // inside <pre>, no extra wrapping
        s.inCode++;
        appendInline(s, "`");
        continue;
      }

      if (tag === "strong" || tag === "b") {
        appendInline(s, "**");
        continue;
      }
      if (tag === "em" || tag === "i") {
        appendInline(s, "*");
        continue;
      }
      if (tag === "del" || tag === "s" || tag === "strike") {
        appendInline(s, "~~");
        continue;
      }

      if (tag === "a") {
        const href = attr(tok.raw, "href");
        s.hrefStack.push(href);
        s.anchorBuf = "";
        continue;
      }

      if (tag === "img") {
        const src = attr(tok.raw, "src");
        const alt = attr(tok.raw, "alt") ?? "";
        if (src) appendInline(s, `![${alt}](${src})`);
        continue;
      }

      // Tables — flatten to a simple pipe representation so the model can
      // see the relationship without us implementing column-width logic.
      if (tag === "tr") { pushLine(s, ""); continue; }
      if (tag === "td" || tag === "th") {
        appendInline(s, " | ");
        continue;
      }

      // Unknown tags pass through as text — children still flow.
      continue;
    }

    // close
    const tag = tok.tag;

    if (tag === "head") { s.inHead = Math.max(0, s.inHead - 1); continue; }
    if (tag === "title") {
      // Make sure title block ends.
      pushLine(s, "");
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      pushLine(s, "");
      continue;
    }

    if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "main" || tag === "header" || tag === "footer" || tag === "nav") {
      pushLine(s, "");
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      s.listStack.pop();
      if (s.listStack.length === 0) pushLine(s, "");
      continue;
    }

    if (tag === "li") {
      // Each <li> we close finalizes its current text into the existing line.
      continue;
    }

    if (tag === "blockquote") {
      s.inBlockquote = Math.max(0, s.inBlockquote - 1);
      pushLine(s, "");
      continue;
    }

    if (tag === "pre") {
      s.inPre = Math.max(0, s.inPre - 1);
      pushLine(s, "```");
      pushLine(s, "");
      continue;
    }
    if (tag === "code" && s.inCode > 0) {
      s.inCode--;
      appendInline(s, "`");
      continue;
    }

    if (tag === "strong" || tag === "b") { appendInline(s, "**"); continue; }
    if (tag === "em" || tag === "i") { appendInline(s, "*"); continue; }
    if (tag === "del" || tag === "s" || tag === "strike") { appendInline(s, "~~"); continue; }

    if (tag === "a") {
      const href = s.hrefStack.pop();
      const text = (s.anchorBuf ?? "").trim();
      s.anchorBuf = null;
      if (!text) continue;
      if (href) {
        appendInline(s, `[${text}](${href})`);
      } else {
        appendInline(s, text);
      }
      continue;
    }

    if (tag === "tr") { pushLine(s, ""); continue; }
  }

  // ── Final whitespace pass ────────────────────────────────────────────────
  const joined = s.out.join("\n");
  // Strip trailing whitespace per line.
  const trimmedLines = joined.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
  // Collapse 3+ blank lines to 2.
  let collapsed = trimmedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length > maxChars) {
    collapsed = collapsed.slice(0, maxChars) + "\n\n[Content truncated to " + maxChars + " chars]";
  }
  return collapsed;
}
