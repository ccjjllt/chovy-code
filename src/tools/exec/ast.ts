/**
 * Bash command AST — lightweight, self-contained parser (step-09).
 *
 * Goals:
 *   1. Produce a *structural* view of a shell command line that downstream
 *      code (danger detection, classification, ATP relevance) can reason
 *      about without re-executing tokenization tricks each time.
 *   2. Stay tiny and dependency-free: we are NOT replicating mvdan/sh or
 *      cc-haha's tree-sitter-bash pipeline. We just need enough to:
 *        - split a line into a chain of simple commands (`&&`, `||`, `;`,
 *          `|`, `&`),
 *        - recognize redirections (`>`, `>>`, `<`, `2>&1`),
 *        - flag heredocs (`<<EOF` / `<<-`) and subshells (`$(...)`, ``` `…` ```,
 *          `(...)`),
 *        - peel leading env-var assignments off each command (`FOO=bar cmd`).
 *   3. **Fail conservatively.** When the parser cannot make sense of the
 *      input it returns `{ ok: false, kind: "too-complex" }` so the bash
 *      tool can treat the command as high-risk (ask the user) instead of
 *      pretending to know what's safe.
 *
 * Why a self-roll instead of pulling shell-quote / mvdan?
 *   - `docs/innovations.md §10` discourages new heavyweight deps for B-phase
 *     tools; the existing fs-tool family is also dep-free.
 *   - We never need to *execute* the AST — only describe it. A simple
 *     character-by-character pass with quote-state tracking is enough.
 *   - cc-haha's tree-sitter pipeline doubles as a security validator; we
 *     keep security as a *separate* table-driven step (see `bash.ts` →
 *     `evaluateDanger`) so the parser stays narrowly scoped.
 *
 * Public surface (consumed by `classification.ts`, `bash.ts`, and the
 * step-09 smoke script):
 *   - `parseBashCommand(input)` → `BashParseResult`
 *   - `BashParse`, `SimpleCommand`, `Redirect`, `ChainOp`
 *   - `extractBaseCommand(simple)` — strips wrappers (env, sudo, nice…)
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ChainOp = "&&" | "||" | ";" | "|" | "&";

/** A single redirection token associated with a command. */
export interface Redirect {
  /** Source fd as written (`""` if absent, `"2"` for `2>`, etc.). */
  fd: string;
  /** Operator literal — `>`, `>>`, `<`, `<<`, `<<-`, `&>`, etc. */
  op: string;
  /** Target token as written; for heredocs this is the delimiter word. */
  target: string;
}

/** One command in the chain (one segment between operators). */
export interface SimpleCommand {
  /** Raw text of just this segment, with surrounding whitespace trimmed. */
  text: string;
  /** Leading `VAR=val` assignments stripped off the front. */
  envVars: Array<{ name: string; value: string }>;
  /** Tokens after env-var assignments. `argv[0]` is the base command name. */
  argv: string[];
  /** Redirections attached to this segment. */
  redirects: Redirect[];
  /** True iff this segment contains `<<` / `<<-` (heredoc). */
  hasHeredoc: boolean;
  /** True iff this segment contains `$(...)` / backticks / `(...)` subshell. */
  hasSubshell: boolean;
  /** Operator that **terminates** this segment (or `null` if it's the last). */
  trailingOp: ChainOp | null;
}

/** Successful parse. */
export interface BashParse {
  ok: true;
  /** Ordered list of simple commands, head-to-tail. */
  commands: SimpleCommand[];
  /** True iff any segment contains a heredoc. */
  hasHeredoc: boolean;
  /** True iff any segment contains a subshell construct. */
  hasSubshell: boolean;
  /** True iff any segment is followed by `&` (backgrounded). */
  hasBackgroundOp: boolean;
}

/** Failure flavors. Both are treated the same by callers (→ high risk). */
export type BashParseFailure =
  | { ok: false; kind: "empty" }
  | { ok: false; kind: "too-complex"; reason: string };

export type BashParseResult = BashParse | BashParseFailure;

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Quote-aware character classes. We track three states:
 *   - `none`   — outside quotes; operators and whitespace are significant.
 *   - `single` — inside `'...'`; nothing escapes (bash semantics).
 *   - `double` — inside `"..."`; `\` escapes a small set of chars.
 *
 * Backtick subshells are handled by counting depth like `$(...)` so the
 * tokenizer doesn't get tricked into ending the command early.
 */
type QuoteState = "none" | "single" | "double";

/** Maximum input length we'll attempt to parse. Anything bigger → too-complex. */
const MAX_INPUT_CHARS = 16 * 1024; // 16 KiB — more than enough for one cmd

/**
 * Maximum number of simple commands we'll surface. Beyond this we bail to
 * `too-complex` to avoid pathological compound commands eating CPU in the
 * downstream danger evaluator (the same backpressure pattern cc-haha uses
 * via `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50`).
 */
const MAX_SEGMENTS = 50;

/**
 * Walk the input once, emitting raw segment slices around chain operators.
 * Returns null when the input is unbalanced (open quotes, runaway subshell).
 */
function splitIntoSegments(
  input: string,
): Array<{ text: string; op: ChainOp | null }> | null {
  const segments: Array<{ text: string; op: ChainOp | null }> = [];
  let buf = "";
  let q: QuoteState = "none";
  let parenDepth = 0; // (...) and $(...)
  let backtickDepth = 0; // `...`
  let braceDepth = 0; // ${...}

  const push = (op: ChainOp | null): boolean => {
    segments.push({ text: buf.trim(), op });
    if (segments.length > MAX_SEGMENTS) return false;
    buf = "";
    return true;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = input[i + 1];

    // ── Quote handling ────────────────────────────────────────────────────
    if (q === "single") {
      // In single quotes nothing escapes — even `\` is literal.
      if (c === "'") q = "none";
      buf += c;
      continue;
    }
    if (q === "double") {
      if (c === "\\" && next !== undefined) {
        // In double quotes, only $ ` " \ <newline> escape. Anything else
        // keeps the backslash. We don't need to honor the difference here —
        // we just consume both characters so an escaped quote/$ doesn't end
        // the quoted run or open a subshell.
        buf += c + next;
        i++;
        continue;
      }
      if (c === "$" && next === "(") {
        parenDepth++;
        buf += "$(";
        i++;
        continue;
      }
      if (c === "`") {
        backtickDepth = backtickDepth === 0 ? 1 : 0;
        buf += c;
        continue;
      }
      if (c === '"') q = "none";
      buf += c;
      continue;
    }

    // q === "none" from here.
    if (c === "'") { q = "single"; buf += c; continue; }
    if (c === '"') { q = "double"; buf += c; continue; }

    if (c === "\\" && next !== undefined) {
      // Backslash escapes the next char outside quotes (including newline →
      // line continuation). Consume both; never treat the escaped char as
      // structural.
      buf += c + next;
      i++;
      continue;
    }

    if (c === "$" && next === "(") {
      parenDepth++;
      buf += "$(";
      i++;
      continue;
    }
    if (c === "(" && backtickDepth === 0) {
      // Bare subshell `(...)`. We still depth-track so a `)` inside doesn't
      // close the wrong nesting level.
      parenDepth++;
      buf += c;
      continue;
    }
    if (c === ")") {
      if (parenDepth > 0) parenDepth--;
      buf += c;
      continue;
    }
    if (c === "`") {
      backtickDepth = backtickDepth === 0 ? 1 : 0;
      buf += c;
      continue;
    }
    if (c === "{" && next !== undefined && /[A-Za-z_#]/.test(next)) {
      // Lightweight `${...}` tracking: only when preceded by `$`. We use a
      // 2-char window in `buf` rather than a full lookahead.
      if (buf.endsWith("$")) {
        braceDepth++;
        buf += c;
        continue;
      }
    }
    if (c === "}" && braceDepth > 0) {
      braceDepth--;
      buf += c;
      continue;
    }

    // ── Chain operators ───────────────────────────────────────────────────
    if (parenDepth === 0 && backtickDepth === 0 && braceDepth === 0) {
      if (c === "&" && next === "&") {
        if (!push("&&")) return null;
        i++;
        continue;
      }
      if (c === "|" && next === "|") {
        if (!push("||")) return null;
        i++;
        continue;
      }
      if (c === "|") {
        if (!push("|")) return null;
        continue;
      }
      if (c === ";") {
        if (!push(";")) return null;
        continue;
      }
      if (c === "&") {
        // Single `&` = background op (also separates commands).
        if (!push("&")) return null;
        continue;
      }
      if (c === "\n") {
        // Treat unescaped newline as a `;` separator.
        if (buf.trim() !== "") {
          if (!push(";")) return null;
        }
        continue;
      }
    }

    buf += c;
  }

  // Balanced?
  if (q !== "none") return null;
  if (parenDepth !== 0 || backtickDepth !== 0 || braceDepth !== 0) return null;

  // Flush trailing segment if any.
  const last = buf.trim();
  if (last !== "" || segments.length === 0) {
    segments.push({ text: last, op: null });
  } else {
    // If the user ended with `&` or `;` we still want a terminator on the
    // previous segment; the loop already set it.
  }

  return segments;
}

/**
 * Tokenize a single command segment into argv (quote-aware). Heredoc-like
 * `<<EOF`, `<<-EOF`, `<<<word` constructs are returned as their own tokens
 * so the redirection scanner downstream can recognize them.
 */
function tokenizeArgv(segment: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let q: QuoteState = "none";
  let parenDepth = 0;
  let backtickDepth = 0;
  const flush = () => {
    if (cur !== "") {
      tokens.push(cur);
      cur = "";
    }
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    const next = segment[i + 1];
    if (q === "single") {
      if (c === "'") { q = "none"; cur += c; continue; }
      cur += c;
      continue;
    }
    if (q === "double") {
      if (c === "\\" && next !== undefined) { cur += c + next; i++; continue; }
      if (c === "$" && next === "(") { parenDepth++; cur += "$("; i++; continue; }
      if (c === "`") { backtickDepth = backtickDepth === 0 ? 1 : 0; cur += c; continue; }
      if (c === '"') { q = "none"; cur += c; continue; }
      cur += c;
      continue;
    }
    if (c === "'") { q = "single"; cur += c; continue; }
    if (c === '"') { q = "double"; cur += c; continue; }
    if (c === "\\" && next !== undefined) { cur += c + next; i++; continue; }
    if (c === "$" && next === "(") { parenDepth++; cur += "$("; i++; continue; }
    if (c === "(") { parenDepth++; cur += c; continue; }
    if (c === ")") { if (parenDepth > 0) parenDepth--; cur += c; continue; }
    if (c === "`") { backtickDepth = backtickDepth === 0 ? 1 : 0; cur += c; continue; }
    if (parenDepth === 0 && backtickDepth === 0 && /\s/.test(c)) {
      flush();
      continue;
    }
    cur += c;
  }
  if (q !== "none" || parenDepth !== 0 || backtickDepth !== 0) return null;
  flush();
  return tokens;
}

/**
 * Walk a token list and separate redirections (`>`, `>>`, `2>`, `<`, `<<`,
 * `<<-`, `<<<`, `&>`, `&>>`, `2>&1`) from argv. The redirection target may be
 * either fused (`>file.txt`) or in the next token (`> file.txt`).
 */
function extractRedirects(tokens: string[]): {
  argv: string[];
  redirects: Redirect[];
  hasHeredoc: boolean;
} {
  const redirects: Redirect[] = [];
  const argv: string[] = [];
  let hasHeredoc = false;

  // Matches `[fd][op]target?` where op ∈ { >, >>, <, <<, <<-, <<<, &>, &>> }
  // and fd is at most a small integer (`2>`, `1>`, etc.).
  const redirRe =
    /^(\d?)(>>|<<-|<<<|<<|&>>|&>|>|<)(.*)$/;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const m = redirRe.exec(tok);
    if (m) {
      const fd = m[1] ?? "";
      const op = m[2]!;
      let target = m[3] ?? "";
      if (target === "" && i + 1 < tokens.length) {
        target = tokens[i + 1]!;
        i++; // consume target token
      }
      redirects.push({ fd, op, target });
      if (op === "<<" || op === "<<-") hasHeredoc = true;
      continue;
    }
    argv.push(tok);
  }
  return { argv, redirects, hasHeredoc };
}

/**
 * Peel leading `VAR=value` assignments off argv. Bash treats these as
 * environment overrides for the following command, not as the command itself.
 * We only consume assignments that look like valid identifier=anything.
 */
const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function extractEnvVars(
  argv: string[],
): { envVars: SimpleCommand["envVars"]; rest: string[] } {
  const envVars: SimpleCommand["envVars"] = [];
  let i = 0;
  while (i < argv.length) {
    const m = ENV_ASSIGN_RE.exec(argv[i]!);
    if (!m) break;
    envVars.push({ name: m[1]!, value: m[2]! });
    i++;
  }
  return { envVars, rest: argv.slice(i) };
}

/**
 * Detect subshell constructs in a segment. We treat any of `$(`, ``\``, or
 * a bare `(` outside quotes as a subshell signal — danger evaluation reads
 * this to bias toward `ask`.
 */
function detectSubshell(segment: string): boolean {
  // Cheap pre-screen first to avoid the full state walk for trivial text.
  if (!/[`(]/.test(segment)) return false;
  let q: QuoteState = "none";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    const next = segment[i + 1];
    if (q === "single") { if (c === "'") q = "none"; continue; }
    if (q === "double") {
      if (c === "\\" && next !== undefined) { i++; continue; }
      if (c === "$" && next === "(") return true;
      if (c === "`") return true;
      if (c === '"') q = "none";
      continue;
    }
    if (c === "'") { q = "single"; continue; }
    if (c === '"') { q = "double"; continue; }
    if (c === "\\" && next !== undefined) { i++; continue; }
    if (c === "$" && next === "(") return true;
    if (c === "`") return true;
    if (c === "(") return true;
  }
  return false;
}

/**
 * Parse a raw command line. See module docblock for guarantees.
 */
export function parseBashCommand(input: string): BashParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, kind: "empty" };
  if (trimmed.length > MAX_INPUT_CHARS) {
    return { ok: false, kind: "too-complex", reason: "input too long" };
  }

  const segs = splitIntoSegments(trimmed);
  if (segs === null) {
    return { ok: false, kind: "too-complex", reason: "unbalanced quotes/parens" };
  }

  const commands: SimpleCommand[] = [];
  let hasHeredoc = false;
  let hasSubshell = false;
  let hasBackgroundOp = false;

  for (let i = 0; i < segs.length; i++) {
    const { text, op } = segs[i]!;
    if (text === "") continue;
    const argvTokens = tokenizeArgv(text);
    if (argvTokens === null) {
      return {
        ok: false,
        kind: "too-complex",
        reason: `cannot tokenize segment #${i + 1}`,
      };
    }
    const { argv: argvWithEnv, redirects, hasHeredoc: heredocHere } =
      extractRedirects(argvTokens);
    const { envVars, rest } = extractEnvVars(argvWithEnv);
    const sub = detectSubshell(text);
    if (heredocHere) hasHeredoc = true;
    if (sub) hasSubshell = true;
    if (op === "&") hasBackgroundOp = true;

    commands.push({
      text,
      envVars,
      argv: rest,
      redirects,
      hasHeredoc: heredocHere,
      hasSubshell: sub,
      trailingOp: op,
    });
  }

  if (commands.length === 0) return { ok: false, kind: "empty" };

  return {
    ok: true,
    commands,
    hasHeredoc,
    hasSubshell,
    hasBackgroundOp,
  };
}

// ── Public helpers ─────────────────────────────────────────────────────────

/**
 * Common wrappers that pass through to the real command. cc-haha's
 * `stripWrappersFromArgv` does this too; the list is intentionally tiny
 * — we'd rather under-strip and ask the user than misclassify a sudo-wrapped
 * `rm`. Anything not listed here just keeps its argv[0].
 */
const PASSTHROUGH_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "nohup",
  "stdbuf",
  "time",
  "timeout",
  "xargs",
]);

/**
 * Best-effort base command name (lowercased, basename only). Used by the
 * classification table and the danger evaluator. Returns `""` when the
 * command has no argv (e.g. pure assignment `FOO=bar`).
 */
export function extractBaseCommand(simple: SimpleCommand): string {
  let i = 0;
  while (i < simple.argv.length) {
    const t = simple.argv[i]!.toLowerCase();
    if (PASSTHROUGH_WRAPPERS.has(t)) {
      // Skip wrapper-specific flag noise: `sudo -u foo cmd`, `timeout 5s cmd`,
      // `nice -n 10 cmd`. We swallow leading `-flags` and a single
      // arg-taking flag token. Anything fancier → bail out at this token.
      i++;
      while (i < simple.argv.length && simple.argv[i]!.startsWith("-")) {
        // `-u`, `-n`, `-k`, `--user=`, ... heuristic: if it's a `-x` short
        // flag with no `=`, also skip the following arg.
        const tok = simple.argv[i]!;
        i++;
        if (/^-[a-zA-Z]$/.test(tok) && i < simple.argv.length) i++;
      }
      // `timeout` also takes a duration token before the real command.
      if (t === "timeout" && i < simple.argv.length &&
          /^\d+[smhd]?$/.test(simple.argv[i]!)) {
        i++;
      }
      continue;
    }
    // Take the basename so `/usr/bin/git` classifies as `git`.
    const last = t.split(/[\\/]/).pop() ?? t;
    return last;
  }
  return "";
}
