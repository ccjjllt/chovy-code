/**
 * Dynamic prompt snippets (step-15).
 *
 * Each helper emits one section of the dynamic suffix (everything below
 * `CHOVY_PROMPT_DYNAMIC_BOUNDARY`). Sections are kept independent so
 * step-25 (memory injection) and step-28 (context rebuild) can swap parts
 * in/out per request without rewriting the whole prompt.
 *
 * Token discipline: each snippet caps its own size; the caller in
 * `builders.ts` aggregates them. We never call a tokenizer here — the
 * static guarantees come from char limits, which is good enough for a
 * prompt prefix that gets re-hashed every turn.
 */

const MEMORY_SECTION_BUDGET = 4000; // chars; ≈1k tokens
const NOTES_SECTION_BUDGET = 1500;
const SKILLS_LINE_BUDGET = 800;

/** `<cwd>` + git status (set externally; we don't shell out from here). */
export interface CwdSnippet {
  cwd: string;
  branch?: string;
  status?: "clean" | "dirty" | "unknown";
  /** Whether the cwd is a git repo at all. */
  isGitRepo?: boolean;
}

export function cwdSection(s: CwdSnippet): string {
  const lines = [`## Working directory`, `cwd: ${s.cwd}`];
  if (s.isGitRepo === false) {
    lines.push("git: (not a git repository)");
  } else if (s.branch) {
    const status = s.status ?? "unknown";
    lines.push(`git: branch=${s.branch} status=${status}`);
  }
  return lines.join("\n");
}

/** Provider + model. Knowledge cutoff is intentionally opt-in (per-step-17). */
export function modelSection(s: {
  provider: string;
  model: string;
  knowledgeCutoff?: string;
  contextWindow?: number;
}): string {
  const lines = [`## Model`, `provider: ${s.provider}`, `model: ${s.model}`];
  if (s.knowledgeCutoff) lines.push(`knowledge cutoff: ${s.knowledgeCutoff}`);
  if (s.contextWindow) lines.push(`context window: ${s.contextWindow} tokens`);
  return lines.join("\n");
}

/**
 * MEMORY.md / checkpoint summary section. The caller passes preformatted
 * text (memory injection lives in step-25); here we only enforce the
 * 4 KB cap and emit a "(empty)" placeholder when nothing is staged.
 */
export function memorySection(text?: string): string {
  if (!text || !text.trim()) {
    return `## Memory (MEMORY.md / checkpoints)\n(no memory loaded)`;
  }
  const trimmed = text.length > MEMORY_SECTION_BUDGET
    ? text.slice(0, MEMORY_SECTION_BUDGET) + "\n…(truncated)"
    : text;
  return `## Memory (MEMORY.md / checkpoints)\n${trimmed}`;
}

export function notesSection(text?: string): string {
  if (!text || !text.trim()) return "";
  const trimmed = text.length > NOTES_SECTION_BUDGET
    ? text.slice(0, NOTES_SECTION_BUDGET) + "\n…(truncated)"
    : text;
  return `## Scratch notes\n${trimmed}`;
}

export function skillsSection(skills?: string[]): string {
  if (!skills || skills.length === 0) return "";
  const joined = skills.join(", ");
  const trimmed = joined.length > SKILLS_LINE_BUDGET
    ? joined.slice(0, SKILLS_LINE_BUDGET) + " …"
    : joined;
  return `## Loaded skills\n${trimmed}`;
}

/**
 * Self-reported context-budget line so the model knows how much head-room
 * it has. Step-27 injects real numbers; step-15 accepts the snapshot
 * shape but tolerates partial / missing fields.
 */
export interface ContextBudgetSnippet {
  used: number;
  total: number;
  /** Per-bucket allocation (memory / checkpoint / notes / skills / tail). */
  budgets?: Record<string, number>;
}

export function contextBudgetSection(b?: ContextBudgetSnippet): string {
  if (!b || !b.total) return "";
  const pct = Math.min(100, Math.round((b.used / b.total) * 100));
  const head = `## Context budget\nused: ${b.used}/${b.total} tokens (${pct}%)`;
  if (!b.budgets) return head;
  const allocs = Object.entries(b.budgets)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${head}\nbudgets: ${allocs}`;
}

/**
 * SCW pressure block (step-27 §"提示主 agent 段").
 *
 * Rendered when the monitor crosses the soft / hard threshold. We use an
 * XML-style block (matches the spec verbatim) rather than markdown so the
 * model can grep for `<context-pressure>` and respond uniformly across
 * providers. `'fresh'` renders nothing — keeps the dynamic suffix stable
 * below the soft threshold (no PSF churn for healthy conversations).
 */
export interface PressureSnippet {
  level: "fresh" | "soft" | "hard";
  usedPct: number;
  remainingTokens: number;
  /** Whether a checkpoint was just written; controls the closing line. */
  checkpointWritten: boolean;
}

export function pressureSection(p?: PressureSnippet): string {
  if (!p || p.level === "fresh") return "";
  const used = Math.max(0, Math.min(100, Math.round(p.usedPct)));
  const remaining = Math.max(0, Math.floor(p.remainingTokens));
  if (p.level === "soft") {
    const ckpt = p.checkpointWritten
      ? "checkpoint 已自动保存。"
      : "若你正在做长任务，主动写 progress.md / 触发 /checkpoint。";
    return [
      `<context-pressure level="soft" used="${used}%" remaining_tokens="${remaining}">`,
      `你的上下文使用接近 75%。请尝试：`,
      `- 精炼回答；`,
      `- 完成手头的子步骤后通过 TodoWrite 收尾；`,
      `- 调用 dispatch 时降低 prompts 数量。`,
      ckpt,
      `</context-pressure>`,
    ].join("\n");
  }
  // hard
  const ckpt = p.checkpointWritten
    ? "checkpoint 已自动保存；step-28 重建协议会接管下一轮。"
    : "立即触发 /checkpoint now，并避免再开新长任务。";
  return [
    `<context-pressure level="hard" used="${used}%" remaining_tokens="${remaining}">`,
    `上下文使用已超过 90%——接近模型硬上限。请立刻：`,
    `- 用一句话总结当前进展并调用 TodoWrite 收尾；`,
    `- 不要再开启新的子任务 / dispatch；`,
    `- 让用户看到要点再继续。`,
    ckpt,
    `</context-pressure>`,
  ].join("\n");
}

/** Filter out empty sections + glue with blank lines. */
export function joinSections(sections: Array<string | undefined>): string {
  return sections.filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}
