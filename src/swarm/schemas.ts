/**
 * Judge aggregator schemas (step-21).
 *
 * Four built-in zod schemas the judge model is constrained to emit, plus the
 * `CustomMeta` factory that wraps a caller-supplied schema into the
 * `{ items: [...] }` envelope `runJudge` expects for the `custom` schema name.
 *
 * Single-source: these schemas are the *only* place the judge's output shape
 * is declared. `router.ts` keys off `JudgeSchemaName`; `judge.ts` selects a
 * schema by name and `safeParse`s the model's (post-`tryFixJSON`) output. The
 * `JudgedAggregate.data` field carries the parsed result back to the main
 * agent via `DispatchOutput.judgement` (step-20 freeze: the field is
 * `unknown` so the router stays schema-agnostic).
 *
 * The field caps (`max(500)`, `max(10)`, `0..1`, `0..10`) come straight from
 * `docs/step-21-judge-aggregator.md §内置 schema`. Tighten/loosen them there
 * first; this file mirrors the spec.
 */
import { z } from "zod";

/**
 * Consensus: "did the N sub-agents agree, and what's the merged answer?"
 *
 * The default schema `dispatch.judge.schema` lands on when the caller omits
 * it. The judge MUST cite each agent's key sentence in `evidence` so the main
 * agent can audit the verdict.
 */
export const ConsensusSchema = z.object({
  agreement: z.enum(["strong", "weak", "split", "conflict"]),
  evidence: z
    .array(
      z.object({
        fromAgentId: z.string(),
        excerpt: z.string().max(500),
        weight: z.number().min(0).max(1),
      }),
    )
    .max(50),
  risks: z.array(z.string()).max(10),
  unresolved: z.array(z.string()).max(10),
  final_answer: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * Compare: pairwise diff + winner across agents. Useful when the dispatch
 * sent the *same* prompt to N heterogeneous providers and the main agent
 * wants a head-to-head ranking rather than a merge.
 */
export const CompareSchema = z.object({
  pairs: z
    .array(
      z.object({
        a: z.string(),
        b: z.string(),
        diff: z.string(),
        winner: z.enum(["a", "b", "tie"]),
      }),
    )
    .max(50),
  recommendation: z.string(),
});

/**
 * Rank: score each agent 0–10 with a one-line reason, then name a top pick.
 * The judge is told to anchor on the rubric in the system prompt (correctness,
 * completeness, risk-awareness) — the numeric score is secondary signal.
 */
export const RankSchema = z.object({
  ranking: z
    .array(
      z.object({
        agentId: z.string(),
        score: z.number().min(0).max(10),
        reason: z.string(),
      }),
    )
    .max(100),
  topPick: z.string(),
});

/**
 * Custom meta-schema: wrap a caller-supplied zod schema into the
 * `{ items: [...] }` envelope `runJudge` expects. The caller passes the
 * inner schema via `dispatch.judge.customSchema`; we validate each element
 * against it so the model can return a list of arbitrary structured records
 * (e.g. extracted TODOs, categorized risks).
 */
export function CustomMeta(s: z.ZodTypeAny): z.ZodObject<{ items: z.ZodArray<typeof s> }> {
  return z.object({ items: z.array(s) });
}

/** Map a schema name to its zod schema. `custom` requires `customSchema`. */
export function schemaFor(
  name: JudgeSchemaNameLike,
  customSchema?: unknown,
): z.ZodTypeAny {
  switch (name) {
    case "consensus":
      return ConsensusSchema;
    case "compare":
      return CompareSchema;
    case "rank":
      return RankSchema;
    case "custom": {
      if (customSchema && isZodSchema(customSchema)) {
        return CustomMeta(customSchema);
      }
      // No valid custom schema → fall back to a permissive envelope so the
      // judge still returns *something* parseable instead of hard-failing.
      return CustomMeta(z.unknown());
    }
    default:
      return ConsensusSchema;
  }
}

/** Names of the built-in judge schemas (mirrors `JudgeSchemaName` in router). */
export type JudgeSchemaNameLike = "consensus" | "compare" | "rank" | "custom";

function isZodSchema(v: unknown): v is z.ZodTypeAny {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { safeParse?: unknown }).safeParse === "function" &&
    typeof (v as { parse?: unknown }).parse === "function"
  );
}
