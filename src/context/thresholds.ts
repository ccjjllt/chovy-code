/**
 * Adaptive thresholds (step-27 §自适应阈值).
 *
 * Resolves the soft / hard / reserve cutoffs for a given (provider, model)
 * by combining:
 *
 *   1. PCM single source — `CAPS[provider].contextWindow` (step-17;
 *      AGENTS.md §17 — never hardcode a window size here).
 *   2. Project config — `cfg.context.{softRatio,hardRatio,reserveTokens}`
 *      (step-02 already shipped these defaults: 0.75 / 0.9 / 2048).
 *   3. Per-process env overrides — `CHOVY_CTX_SOFT_RATIO` /
 *      `CHOVY_CTX_HARD_RATIO` / `CHOVY_CTX_RESERVE_TOKENS`.
 *      Used to crank thresholds down for SCW smoke tests.
 *
 * Validation: ratios must satisfy `0 < soft < hard < 1` AND `soft >= 0.5`
 * (avoid trivially-true thresholds). Failed validation falls back to
 * `cfg.context` defaults with a `logger.warn` — we never throw out of a
 * monitor refresh because the user could simply set bad env vars.
 */

import { logger } from "../logger/index.js";
import { CAPS } from "../providers/capabilities.js";
import type { ChovyConfig } from "../config/config.js";
import type { ProviderId } from "../types/provider.js";

export interface ContextThresholds {
  /** Provider's context window (tokens). */
  ctxWindow: number;
  /** Soft trigger — usually `ctxWindow * 0.75`. */
  soft: number;
  /** Hard trigger — usually `ctxWindow * 0.90`. Step-28 owns the response. */
  hard: number;
  /** Reserved tokens for output (subtracted from `ctxWindow` budget). */
  reserve: number;
  /** Effective input budget (`ctxWindow - reserve`); capped at `ctxWindow`. */
  effectiveWindow: number;
}

/** Lower bound for soft ratio — anything below 0.5 is almost certainly a typo. */
const MIN_SOFT_RATIO = 0.5;
/** Upper bound for hard ratio — beyond 0.99 there's no headroom for output. */
const MAX_HARD_RATIO = 0.99;

interface ResolvedRatios {
  softRatio: number;
  hardRatio: number;
  reserveTokens: number;
}

function parseRatio(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) return undefined;
  if (v <= 0 || v >= 1) return undefined;
  return v;
}

function parseInt0(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}

/**
 * Merge ratios from cfg + env, validating the result. Returns the cfg
 * values (with a warn) if the env layer produces an inconsistent set.
 */
function resolveRatios(
  cfg: ChovyConfig,
  env: NodeJS.ProcessEnv,
): ResolvedRatios {
  const cfgRatios: ResolvedRatios = {
    softRatio: cfg.context.softRatio,
    hardRatio: cfg.context.hardRatio,
    reserveTokens: cfg.context.reserveTokens,
  };

  const softEnv = parseRatio(env["CHOVY_CTX_SOFT_RATIO"]);
  const hardEnv = parseRatio(env["CHOVY_CTX_HARD_RATIO"]);
  const reserveEnv = parseInt0(env["CHOVY_CTX_RESERVE_TOKENS"]);

  const merged: ResolvedRatios = {
    softRatio: softEnv ?? cfgRatios.softRatio,
    hardRatio: hardEnv ?? cfgRatios.hardRatio,
    reserveTokens: reserveEnv ?? cfgRatios.reserveTokens,
  };

  // Validate post-merge. Use cfg fallback when env produces an inconsistent
  // pair (e.g. soft=0.95 + hard=0.5). Explicit warn so users debug fast.
  const ok =
    merged.softRatio >= MIN_SOFT_RATIO &&
    merged.softRatio < merged.hardRatio &&
    merged.hardRatio <= MAX_HARD_RATIO;
  if (!ok) {
    logger.warn("context.thresholds: invalid ratio pair, using config defaults", {
      softRatio: merged.softRatio,
      hardRatio: merged.hardRatio,
      cfgSoft: cfgRatios.softRatio,
      cfgHard: cfgRatios.hardRatio,
    });
    return cfgRatios;
  }
  return merged;
}

/**
 * Compute the thresholds for a (provider, model) pair. `model` is currently
 * unused — provider-level granularity matches PCM (one context window per
 * provider id). When per-model windows ship, lookup keys upgrade here.
 */
export function thresholds(
  _model: string,
  provider: ProviderId,
  cfg: ChovyConfig,
  env: NodeJS.ProcessEnv = process.env,
): ContextThresholds {
  const cap = CAPS[provider];
  if (!cap) {
    // Should never happen — provider validated by zod at config load. Bail
    // with a generous fallback so callers don't crash.
    logger.warn("context.thresholds: unknown provider, using 128k fallback", {
      provider,
    });
    return {
      ctxWindow: 128_000,
      soft: 96_000,
      hard: 115_200,
      reserve: 2048,
      effectiveWindow: 125_952,
    };
  }
  const ctxWindow = cap.contextWindow;
  const { softRatio, hardRatio, reserveTokens } = resolveRatios(cfg, env);

  // Reserve cannot eat the whole window — clip at 50 % to keep ratios
  // meaningful even if the user sets CHOVY_CTX_RESERVE_TOKENS too high.
  const reserve = Math.min(reserveTokens, Math.floor(ctxWindow / 2));
  const effectiveWindow = ctxWindow - reserve;

  return {
    ctxWindow,
    soft: Math.floor(ctxWindow * softRatio),
    hard: Math.floor(ctxWindow * hardRatio),
    reserve,
    effectiveWindow,
  };
}
