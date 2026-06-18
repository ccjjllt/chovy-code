/**
 * Swarm Router (step-20 SwarmR).
 *
 * The dispatch entry point: hand the main agent a single `dispatch(...)` call
 * that fans N prompts out to N sub-agents (≤ 100), each independently
 * configured (role / provider / model / tools / budget / timeout), collects
 * results in *original array order*, and returns an aggregate. This is the
 * innovation core — `docs/innovations.md §3 SwarmR`.
 *
 * Algorithm (mirrors `docs/step-20-swarm-router.md §算法`):
 *
 *   1. validate prompts (1..100) + capacity (prompts + active ≤ MAX).
 *   2. build a SpawnInput per prompt (default `shareSession: true` so each
 *      child inherits the parent snapshot via step-18's snapshot builder).
 *   3. wrap each spawn in a p-limit-style limiter so `parallelism` is
 *      enforced even though the pool would happily accept all 100 at once.
 *   4. collect handles into result slots keyed by original index.
 *   5. poll the handles: on each tick, recompute cumulative cost against
 *      `GlobalBudget`; on trip, `swarmPool.cancelAll()` the unfinished set.
 *   6. if `judge.enabled`, hand the collected results to step-21's judge.
 *      (TODO step-21: today `judgement` stays `undefined` and the field is
 *      reserved — see `JUDGE_NOT_IMPLEMENTED`.)
 *   7. emit one `swarm.dispatch` telemetry event.
 *   8. return `DispatchOutput`.
 *
 * Cancellation: a caller-supplied `abortSignal` is wrapped in a *local*
 * AbortController (AGENTS.md §9: never share the parent's signal across
 * runs). Aborting the dispatch trips `stopReason: 'cancelled'` and cancels
 * every still-running child via `swarmPool.cancelAll()`.
 *
 * Failure propagation (`docs/step-20 §失败传播`): a single child failing
 * does NOT abort siblings — its result slot is `ok:false` and the judge (if
 * enabled) is told "this angle produced no valid conclusion". Only the
 * global budget / dispatch-level abort cancel the whole fan-out.
 *
 * The router does NOT recommend provider/role strategy per prompt — the main
 * agent decides. The default-prompt snippet in `docs/step-20 §异构 provider
 * 路由` is the suggestion surface; the router is a dumb orchestrator.
 */
import { logger } from "../logger/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { ChovyError } from "../types/errors.js";
import type {
  AgentRole,
  ChatMessage,
  ParentRuntimeCtx,
  ProviderId,
  SpawnInput,
  SubAgentHandle,
} from "../types/index.js";
import { createLimiter, type ConcurrencyLimiter } from "./concurrency.js";
import { createGlobalBudget, type GlobalBudget } from "./budgets.js";
import {
  createSwarmBus,
  swarmBus as defaultBus,
  toLifecycleEvent,
  type SwarmBus,
} from "./progress.js";
import { createSwarmPool, type SwarmPool } from "./pool.js";

// ── public types ───────────────────────────────────────────────────────────

/** Role vocabulary exposed on the dispatch tool wire schema (step-20). The
 *  four built-in roles ship in step-19; `custom` is the escape hatch. */
export type DispatchRole = "explore" | "plan" | "verify" | "critic" | "custom";

/** Judge aggregator schema name (step-21 owns the real impl). */
export type JudgeSchemaName = "consensus" | "compare" | "rank" | "custom";

export interface DispatchPrompt {
  id?: string;
  prompt: string;
  role?: DispatchRole;
  provider?: ProviderId;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTokens?: number;
  timeoutMs?: number;
  budgetUSD?: number;
}

export interface DispatchJudgeOptions {
  enabled: boolean;
  schema: JudgeSchemaName;
  customSchema?: unknown;
  provider?: ProviderId;
  model?: string;
}

export interface DispatchInput {
  prompts: DispatchPrompt[];
  judge?: Partial<DispatchJudgeOptions>;
  /** Concurrent in-flight spawns; default 8. Hard-clamped to [1, 100]. */
  parallelism?: number;
  /** Inject the parent snapshot into each child? Default true. */
  shareSession?: boolean;
  /** Dispatch-wide USD cap. Inert when unset / non-finite. */
  budgetUSD?: number;
  /** Per-child prompt-token cap forwarded to the provider. */
  maxTokens?: number;
  /** Caller-controlled cancellation. Wrapped locally (never shared). */
  abortSignal?: AbortSignal;
}

export interface DispatchChildResult {
  id: string;
  ok: boolean;
  content: string;
  structuredOutput?: unknown;
  costUSD: number;
  /** Terminal status of the underlying handle. */
  status: SubAgentHandle["status"];
  /** Absent reason when `ok === false`. */
  reason?: string;
  provider?: ProviderId;
  model?: string;
}

export interface DispatchOutput {
  spawnedIds: string[];
  results: DispatchChildResult[];
  /** step-21 fills this; `undefined` until the judge ships. */
  judgement?: unknown;
  totalCostUSD: number;
  stopReason: "final" | "budgetExceeded" | "cancelled";
}

export interface DispatchDeps {
  /** Inject the swarm pool (tests pass a fake). */
  pool?: SwarmPool;
  /** Inject the bus (tests pass an isolated one). */
  bus?: SwarmBus;
  /** Inject the limiter factory (tests assert the active-count invariant). */
  limiter?: (concurrency: number) => ConcurrencyLimiter;
}

// ── constants ──────────────────────────────────────────────────────────────

/** Hard cap from `docs/step-20 §dispatch 工具协议` (prompts.max = 100). */
export const MAX_DISPATCH_PROMPTS = 100;
/** Default parallelism per `docs/step-20` schema default. */
export const DEFAULT_PARALLELISM = 8;
/** Poll interval (ms) for the budget watchdog + progress bus. */
const POLL_INTERVAL_MS = 100;
/** Grace window (ms) for children to settle after a cancelAll. */
const CANCEL_SETTLE_MS = 2500;

// ── role mapping ───────────────────────────────────────────────────────────

/**
 * Map the wire-schema `DispatchRole` to the runtime `AgentRole` (step-18).
 * The two vocabularies intentionally differ: the wire schema uses the short
 * imperative form the model is likely to emit (`explore`/`plan`/...), while
 * the runtime uses the noun form (`explorer`/`planner`/...) that step-19
 * built-in definitions key on. `custom` → `custom` (the escape hatch).
 */
export function toAgentRole(role: DispatchRole | undefined): AgentRole {
  switch (role) {
    case "explore":
      return "explorer";
    case "plan":
      return "planner";
    case "verify":
      return "verifier";
    case "critic":
      return "critic";
    case "custom":
      return "custom";
    default:
      return "main";
  }
}

// ── judge placeholder ──────────────────────────────────────────────────────

/**
 * Step-21 owns the judge aggregator. Until it lands, a `judge.enabled:true`
 * dispatch still succeeds — the judge step is skipped and `judgement` stays
 * `undefined`. We log once per dispatch so the omission is observable in
 * `chovy log tail` without throwing (the main agent gets its raw results).
 *
 * TODO step-21: replace this stub with `runJudge(results, judgeOpts)` from
 * `src/swarm/judge.ts`.
 */
const JUDGE_NOT_IMPLEMENTED =
  "judge aggregator not implemented (step-21); returning raw results";

// ── dispatch ───────────────────────────────────────────────────────────────

/**
 * Fan out `prompts` to N sub-agents, collect results in original order, and
 * (when enabled) hand them to the step-21 judge.
 *
 * The router never throws on a *child* failure — those land as `ok:false`
 * result slots. It DOES throw on invalid input (empty / oversized prompts,
 * capacity breach) so the dispatch tool can surface a structured error to
 * the model.
 */
export async function dispatch(
  input: DispatchInput,
  parentCtx: ParentRuntimeCtx,
  deps: DispatchDeps = {},
): Promise<DispatchOutput> {
  const prompts = input.prompts;
  if (!Array.isArray(prompts) || prompts.length < 1) {
    throw new ChovyError(
      "INTERNAL",
      "dispatch: prompts must be a non-empty array",
      undefined,
      { count: Array.isArray(prompts) ? prompts.length : -1 },
    );
  }
  if (prompts.length > MAX_DISPATCH_PROMPTS) {
    throw new ChovyError(
      "INTERNAL",
      `dispatch: prompts length ${prompts.length} exceeds cap ${MAX_DISPATCH_PROMPTS}`,
      undefined,
      { count: prompts.length, cap: MAX_DISPATCH_PROMPTS },
    );
  }

  const bus = deps.bus ?? defaultBus;
  const swarmPool =
    deps.pool ?? createSwarmPool({ bus });
  const makeLimiter = deps.limiter ?? createLimiter;

  // Capacity pre-check: prompts + currently-active handles ≤ MAX. The pool
  // enforces the 100-active cap itself, but failing here gives the router a
  // clean error instead of a mid-dispatch `AGENT_BUDGET_EXCEEDED`.
  if (!swarmPool.canFit(prompts.length)) {
    throw new ChovyError(
      "AGENT_BUDGET_EXCEEDED",
      `dispatch: ${prompts.length} prompts would overflow the sub-agent pool ` +
        `(${swarmPool.activeCount()} active, cap 100)`,
      undefined,
      { requested: prompts.length, active: swarmPool.activeCount() },
    );
  }

  const parallelism = clampParallelism(input.parallelism);
  const limiter = makeLimiter(parallelism);
  const budget: GlobalBudget = createGlobalBudget(input.budgetUSD);

  // Local AbortController wrapping the caller's signal (AGENTS.md §9). A
  // local AC lets us trip programmatic cancels (budget breach) without
  // touching the caller's signal object.
  const ac = new AbortController();
  let externalTripped = false;
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      ac.abort();
      externalTripped = true;
    } else {
      const onExternalAbort = (): void => {
        externalTripped = true;
        ac.abort();
      };
      input.abortSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
      // Detach once our work settles (finally-block below is the canonical
      // spot; we mirror QueryEngine's removeEventListener pattern).
      ac.signal.addEventListener(
        "abort",
        () =>
          input.abortSignal!.removeEventListener("abort", onExternalAbort),
        { once: true },
      );
    }
  }

  // When the local AC aborts (external dispatch abort OR budget breach), cancel
  // every still-running child. Children's own AbortControllers cascade from
  // `parentCtx.parentSignal` (the parent run's signal), NOT from this router's
  // `ac` — so tripping `ac` alone wouldn't reach them. The watchdog's budget
  // path already calls cancelAll(); this listener covers the external-abort
  // path so a cancelled dispatch lands every unfinished child as `cancelled`.
  const onCancelAll = (): void => {
    void swarmPool.cancelAll().catch(() => {});
  };
  if (ac.signal.aborted) onCancelAll();
  else ac.signal.addEventListener("abort", onCancelAll, { once: true });

  const shareSession = input.shareSession ?? true;

  // Stable per-slot ids: caller-supplied `id` wins, else a positional label.
  // The id is purely for the result array + bus events — the pool mints its
  // own `sa_…` handle id internally.
  const slotIds: string[] = prompts.map((p, i) => p.id ?? `p${i}`);

  // Result slots, filled in original order regardless of completion order.
  const results: DispatchChildResult[] = prompts.map((p, i) => ({
    id: slotIds[i] ?? `p${i}`,
    ok: false,
    content: "",
    costUSD: 0,
    status: "queued",
    provider: p.provider ?? parentCtx.parentProvider,
    model: p.model ?? parentCtx.parentModel,
  }));

  // Handle refs so the watchdog can poll cost/phase; indexed by slot.
  const handles: (SubAgentHandle | undefined)[] = prompts.map(() => undefined);

  // Telemetry — one event per dispatch (single source per AGENTS.md §17).
  emitTelemetry({
    type: "swarm.dispatch",
    n: prompts.length,
    parallelism,
  });

  let stopReason: DispatchOutput["stopReason"] = "final";

  // Spawn every prompt through the limiter. Each spawn awaits the handle's
  // terminal state (pool.spawn with background:false blocks to completion),
  // so `allSettled` resolves once every child has finished OR been skipped.
  const tasks = prompts.map((prompt, i) =>
    limiter.run(async () => {
      // Pre-spawn cancellation / budget checks. A tripped budget or aborted
      // signal means we skip the spawn and mark the slot as cancelled so
      // the result array stays dense and ordered.
      if (ac.signal.aborted) {
        markCancelled(i, "dispatch aborted before spawn");
        return;
      }
      if (budget.exceeded) {
        markCancelled(i, "budget exceeded before spawn");
        stopReason = "budgetExceeded";
        return;
      }

      const spawnInput: SpawnInput = {
        role: toAgentRole(prompt.role),
        prompt: prompt.prompt,
        provider: prompt.provider,
        model: prompt.model,
        tools: prompt.tools,
        disallowedTools: prompt.disallowedTools,
        shareSession,
        budgetUSD: prompt.budgetUSD,
        timeoutMs: prompt.timeoutMs,
        // TODO step-18 follow-up: forward `prompt.maxTokens ?? input.maxTokens`
        // once SpawnInput grows a per-child maxTokens. Today the pool maps
        // only `maxRounds` into the child QueryEngine; the per-prompt token
        // cap stays on the wire schema (step-20 §dispatch 工具协议) so the
        // field is reserved, not silently dropped from the contract.
        // Context snapshot override is intentionally NOT exposed on the wire
        // schema — the router relies on step-18's live parent snapshot.
      };

      try {
        const handle = await swarmPool.spawn({
          id: slotIds[i] ?? `p${i}`,
          input: spawnInput,
          parentCtx,
        });
        handles[i] = handle;
        // The pool resolves spawn() only at terminal state (background:false),
        // so roll up the final result here.
        rollup(i, handle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // AGENT_BUDGET_EXCEEDED mid-flight → treat as budget breach, not a
        // hard child failure, so siblings keep running.
        if (isBudgetExceeded(err)) {
          markCancelled(i, `pool capacity: ${msg}`);
          stopReason = "budgetExceeded";
          budget.trip();
          void swarmPool.cancelAll().catch(() => {});
        } else {
          markFailed(i, msg);
        }
      }
    }),
  );

  // Watchdog: poll handles while tasks are in flight. Recompute the
  // cumulative spend, emit progress, and trip the budget / cancelAll on
  // breach. The poll loop exits when either all tasks settle or the budget
  // trips (we still await `allSettled` below so cancelled slots roll up).
  const watchdog = startWatchdog(handles, results, budget, bus, swarmPool, ac);

  try {
    await Promise.allSettled(tasks);
  } finally {
    stopWatchdog(watchdog);
  }

  // If the external signal aborted, that takes precedence over budget.
  if (externalTripped) stopReason = "cancelled";
  else if (budget.exceeded && stopReason === "final") stopReason = "budgetExceeded";

  // Give any in-flight cancelAll a moment to settle handle finally-blocks
  // (mirrors smoke-step18's settle loop; children abort their provider call
  // and walk the cancel-grace path).
  if (stopReason !== "final") {
    await settleHandles(handles, CANCEL_SETTLE_MS);
  }

  // Final rollup so cost reflects the settled state after cancels.
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    if (h) rollup(i, h);
  }

  const totalCostUSD = results.reduce((sum, r) => sum + r.costUSD, 0);

  // ── judge (step-21 placeholder) ─────────────────────────────────────────
  const judgeOpts = normalizeJudge(input.judge);
  let judgement: unknown;
  if (judgeOpts.enabled) {
    // TODO step-21: `judgement = await runJudge(results, judgeOpts, parentCtx);`
    logger.warn(JUDGE_NOT_IMPLEMENTED, { schema: judgeOpts.schema });
    judgement = undefined;
  }

  return {
    spawnedIds: handles
      .map((h) => h?.id)
      .filter((x): x is string => typeof x === "string"),
    results,
    judgement,
    totalCostUSD,
    stopReason,
  };

  // ── slot helpers (close over `results`/`handles`) ────────────────────────

  function rollup(i: number, h: SubAgentHandle): void {
    const r = results[i];
    if (!r) return;
    const res = h.result;
    r.status = h.status;
    r.costUSD = h.costUSD;
    r.provider = h.provider ?? r.provider;
    r.model = h.model ?? r.model;
    if (res) {
      r.ok = res.ok;
      r.content = res.content;
      r.structuredOutput = res.structuredOutput;
      r.reason = res.reason;
    } else if (h.status === "cancelled") {
      r.ok = false;
      r.reason = r.reason ?? "cancelled";
    } else if (h.status === "failed") {
      r.ok = false;
      r.reason = r.reason ?? "failed";
    }
  }

  function markCancelled(i: number, reason: string): void {
    const r = results[i];
    if (!r) return;
    r.ok = false;
    r.status = "cancelled";
    r.reason = reason;
    r.content = r.content || "";
  }

  function markFailed(i: number, reason: string): void {
    const r = results[i];
    if (!r) return;
    r.ok = false;
    r.status = "failed";
    r.reason = reason;
    r.content = r.content || "";
  }
}

// ── watchdog ───────────────────────────────────────────────────────────────

interface Watchdog {
  stop(): void;
}

/**
 * Poll every `POLL_INTERVAL_MS`:
 *   - recompute cumulative spend from settled handles,
 *   - emit progress / lifecycle bus events for handles that moved,
 *   - trip the budget + cancelAll on breach.
 *
 * Returns a handle with `stop()` for the finally-block. The loop is
 * cooperative — it checks `ac.signal.aborted` each tick and exits.
 */
function startWatchdog(
  handles: (SubAgentHandle | undefined)[],
  results: DispatchChildResult[],
  budget: GlobalBudget,
  bus: SwarmBus,
  swarmPool: SwarmPool,
  ac: AbortController,
): Watchdog {
  // Track the last status we emitted per handle so we only fire lifecycle
  // events on actual transitions (keeps the bus quiet for long-running
  // children that haven't moved).
  const lastStatus = new Map<string, SubAgentHandle["status"]>();
  const lastTokens = new Map<string, number>();

  const tick = (): void => {
    if (ac.signal.aborted) return;
    let total = 0;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      if (!h) continue;
      total += h.costUSD;
      // Lifecycle transition.
      const prev = lastStatus.get(h.id);
      if (prev !== h.status) {
        lastStatus.set(h.id, h.status);
        bus.emitLifecycle(toLifecycleEvent(h));
      }
      // Progress (phase / token delta). We coalesce to a single event per
      // tick per handle — the UI re-renders on its own cadence anyway.
      const prevTok = lastTokens.get(h.id) ?? 0;
      if (h.tokensOut !== prevTok || (h.phase && h.phase !== prev)) {
        lastTokens.set(h.id, h.tokensOut);
        bus.emitProgress({
          id: h.id,
          phase: h.phase,
          tokensOut: h.tokensOut,
        });
      }
    }
    budget.update(total);
    if (budget.exceeded) {
      // Budget breach → cancel every still-running child. The router's
      // Promise.allSettled still awaits the cancelled tasks so slots roll
      // up as `cancelled` rather than disappearing.
      void swarmPool.cancelAll().catch(() => {});
    }
    // Keep `results` cost in sync mid-flight so a UI reading results[]
    // (rather than the bus) sees monotonic spend.
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      const r = results[i];
      if (h && r) r.costUSD = h.costUSD;
    }
  };

  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  // Run one tick immediately so early budget trips fire before the first
  // interval (helps the budgetExceeded smoke harness stay fast).
  tick();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function stopWatchdog(w: Watchdog): void {
  w.stop();
}

// ── helpers ────────────────────────────────────────────────────────────────

function clampParallelism(n: number | undefined): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : DEFAULT_PARALLELISM;
  return Math.max(1, Math.min(MAX_DISPATCH_PROMPTS, v));
}

function isBudgetExceeded(err: unknown): boolean {
  return (
    err instanceof ChovyError && err.code === "AGENT_BUDGET_EXCEEDED"
  );
}

function normalizeJudge(
  j: DispatchInput["judge"],
): DispatchJudgeOptions {
  if (!j) return { enabled: false, schema: "consensus" };
  return {
    enabled: j.enabled ?? true,
    schema: j.schema ?? "consensus",
    customSchema: j.customSchema,
    provider: j.provider,
    model: j.model,
  };
}

/**
 * Wait (up to `timeoutMs`) for every handle to reach a terminal state.
 * Used after a cancelAll so the result array reflects settled costs.
 */
async function settleHandles(
  handles: (SubAgentHandle | undefined)[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const allTerminal = handles.every((h) => !h || isTerminalStatus(h.status));
    if (allTerminal) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function isTerminalStatus(s: SubAgentHandle["status"]): boolean {
  return s === "done" || s === "failed" || s === "cancelled";
}

// re-exported for the smoke harness / future UI
export { createSwarmBus, type SwarmBus };
export type { ChatMessage };
