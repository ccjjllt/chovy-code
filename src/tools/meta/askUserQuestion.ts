/**
 * `ask_user_question` — interactive prompt to the human (step-11).
 *
 * Per `docs/step-11-meta-tools.md`:
 *   - Surfaces 1–4 questions, each with 2–4 options, via a UI overlay.
 *   - Non-TTY / non-interactive mode ⇒ immediate `TOOL_DENIED` with a clear
 *     "非交互环境无法提问" message (the spec's "交互工具在非交互环境下死锁"
 *     risk is closed by this branch).
 *   - "Other" answers (free text) are allowed; the UI returns the label
 *     `"Other"` plus the user's text and this tool joins them as
 *     `"Other: <text>"` so downstream parsing stays single-valued.
 *   - Returns `{ answers: Record<question, label> }` to the model.
 *
 * Wiring today: the agent loop (step-16) does not yet pass `ToolContext`, so
 * `ctx` is usually `undefined`. When `ctx.askUser` is also absent the tool
 * refuses with `INTERNAL` pointing at step-22 (the Ink `AskUserOverlay` that
 * will supply the callback). This mirrors the Skill/Agent stubs: refuse
 * loudly with a step pointer instead of hanging on stdin.
 *
 * The `isInteractive` gate is honored when present; otherwise the tool
 * inspects `process.stdin.isTTY`. Both one-shot `chat "..."` and sub-agent
 * contexts report non-interactive, so this tool never deadlocks a background
 * run.
 */

import { z } from "zod";

import { logger } from "../../logger/index.js";
import type {
  AskUserAnswer,
  AskUserQuestionSpec,
  PermissionPreflight,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

const HEADER_MAX = 12;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 4;
const QUESTIONS_MIN = 1;
const QUESTIONS_MAX = 4;

const argsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().max(HEADER_MAX),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.object({
              label: z.string().min(1),
              description: z.string(),
              preview: z.string().optional(),
            }),
          )
          .min(OPTIONS_MIN)
          .max(OPTIONS_MAX),
      }),
    )
    .min(QUESTIONS_MIN)
    .max(QUESTIONS_MAX),
});

type Args = z.infer<typeof argsSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decide whether this run is interactive. Priority:
 *   1. `ctx.isInteractive()` when the host wired it (step-22 REPL sets it to
 *      `() => process.stdin.isTTY`; sub-agents force `false`).
 *   2. `process.stdin.isTTY` as a last-resort heuristic.
 *
 * We deliberately do NOT consult `process.stdout.isTTY` — a piped-stdout but
 * TTY-stdin session (rare but real, e.g. redirecting a transcript) should
 * still be allowed to answer.
 */
function isInteractive(ctx?: ToolContext): boolean {
  if (ctx?.isInteractive) {
    try {
      return ctx.isInteractive();
    } catch {
      // A throwing predicate is treated as "no" — better to refuse than hang.
      return false;
    }
  }
  return Boolean(process.stdin?.isTTY);
}

/**
 * Normalize the raw answer map returned by the UI into the model-facing
 * `Record<question, label>` shape. For multi-select the UI joins selected
 * labels with `", "`; for "Other" free text we emit `"Other: <text>"` so the
 * model sees a single value (and can detect the free-form case by prefix).
 */
function normalizeAnswers(
  questions: Args["questions"],
  raw: AskUserAnswer,
): AskUserAnswer {
  const out: AskUserAnswer = {};
  for (const q of questions) {
    const v = raw[q.question];
    if (v === undefined) {
      out[q.question] = "(no answer)";
      continue;
    }
    // The UI may return either a plain label, or for "Other" a value shaped
    // `"Other: <free text>"` already. Pass both through unchanged.
    out[q.question] = v;
  }
  return out;
}

// ── Tool ───────────────────────────────────────────────────────────────────

export const askUserQuestionTool: Tool<typeof argsSchema> = {
  name: "ask_user_question",
  version: 2,
  family: "meta",
  isReadOnly: true, // no world mutation; only blocks on user input
  canUseWithoutAsk: true, // asking *is* the ask — don't double-prompt

  desc: {
    lean:
      "Ask the user a multiple-choice question (1–4 questions, 2–4 options " +
      "each). Blocks until they answer; refused in non-interactive mode.",
    full:
      "Surface a multiple-choice question to the human via a UI overlay.\n\n" +
      `- 1–${QUESTIONS_MAX} questions per call; each has ${OPTIONS_MIN}–${OPTIONS_MAX} options.\n` +
      "- Each option has a `label` (short), `description` (longer), and an " +
      "optional `preview` (markdown/code the UI shows side-by-side).\n" +
      "- `header` is a ≤12-char chip label.\n" +
      "- `multiSelect: true` lets the user pick several; the answer is a " +
      "comma-joined list of labels.\n" +
      "- The user can always pick \"Other\" and type free text; the answer " +
      "comes back as `\"Other: <text>\"`.\n" +
      "- Returns `{ answers: Record<questionText, chosenLabel> }`.\n" +
      "- NON-INTERACTIVE mode (one-shot `chat`, `goal`, sub-agents, piped " +
      "stdin) refuses immediately with `TOOL_DENIED` — it will never hang.\n" +
      "- Reserve this for decisions that genuinely change what you do next " +
      "(architecture, naming, scope). Don't ask for confirmation of obvious " +
      "defaults — pick the sensible option and mention it.",
    examples: [
      `ask_user_question({ questions: [{
  question: "Which auth approach?", header: "Auth",
  options: [
    { label: "JWT", description: "Stateless tokens; fits SPA backends." },
    { label: "Session", description: "Server-side sessions; classic web." },
  ],
}] })`,
      `ask_user_question({ questions: [{
  question: "Which features?", header: "Scope", multiSelect: true,
  options: [
    { label: "Caching", description: "Add a TTL cache layer." },
    { label: "Metrics", description: "Emit Prometheus metrics." },
  ],
}] })`,
    ],
  },

  fullTriggers: [
    /\b(ask\s+(the\s+)?user|question|clarify|which\s+(option|approach|library)|confirm|prefer)\b/i,
    /(问用户|问一下|询问|提问|确认|选哪个|更喜欢|哪种)/,
  ],

  schema: argsSchema,

  userFacingName(args) {
    const n = args?.questions?.length ?? 0;
    return n === 1 ? `Ask: ${args?.questions?.[0]?.header ?? "?"}` : `Ask user (${n} questions)`;
  },

  checkPermissions(): PermissionPreflight {
    // The act of asking IS the permission surface; we don't pre-prompt for it.
    return { outcome: "allow" };
  },

  async run(args: Args, ctx?: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();

    // 1. Non-interactive ⇒ refuse cleanly (spec's risk mitigation).
    if (!isInteractive(ctx)) {
      return {
        ok: false,
        content:
          "非交互环境无法提问（ask_user_question 需要一个 TTY）。" +
          "请在交互式 REPL 中运行，或为 agent 自行选择一个合理默认值。" +
          " (non-interactive environment; cannot prompt the user)",
        errorCode: "TOOL_DENIED",
        structuredOutput: {
          kind: "non-interactive",
          questions: args.questions.length,
        },
        meta: { durMs: Date.now() - t0 },
      };
    }

    // 2. No UI callback wired yet ⇒ refuse pointing at step-22.
    if (!ctx?.askUser) {
      return {
        ok: false,
        content:
          "ask_user_question: interactive overlay not wired yet (step-22). " +
          "The current host has not supplied a `ctx.askUser` callback, so the " +
          "question cannot be displayed. Pick a sensible default and proceed.",
        errorCode: "INTERNAL",
        structuredOutput: {
          kind: "no-overlay",
          step: "step-22",
          questions: args.questions.length,
        },
        meta: { durMs: Date.now() - t0 },
      };
    }

    // 3. Delegate to the UI overlay.
    const specs: AskUserQuestionSpec[] = args.questions.map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect,
      options: q.options.map((o) => ({
        label: o.label,
        description: o.description,
        preview: o.preview,
      })),
    }));

    try {
      const raw = await ctx.askUser(specs, ctx.abortSignal);
      const answers = normalizeAnswers(args.questions, raw);

      // Model-facing content: a compact Q→A render.
      const lines: string[] = ["User answered:"];
      for (const q of args.questions) {
        lines.push(`  Q: ${q.question}`);
        lines.push(`  A: ${answers[q.question] ?? "(no answer)"}`);
      }

      return {
        ok: true,
        content: lines.join("\n"),
        structuredOutput: { kind: "answered", answers },
        meta: { durMs: Date.now() - t0 },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("ask_user_question: UI callback threw", { error: msg });
      return {
        ok: false,
        content: `ask_user_question: user prompt failed — ${msg}`,
        errorCode: "INTERNAL",
        structuredOutput: { kind: "error", error: msg },
        meta: { durMs: Date.now() - t0 },
      };
    }
  },
};
