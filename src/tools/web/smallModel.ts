/**
 * Small-model summarizer for `web_fetch` (step-10).
 *
 * Per `docs/step-10-web-tools.md §2`, the WebFetch tool should answer the
 * user's prompt against the converted markdown using a *small* model
 * (gpt-4o-mini / glm-4-air / gemini-1.5-flash style). The full provider
 * matrix is not wired until step-17 — and most adapters in the tree today
 * are scaffold stubs that throw `PROVIDER_NOT_READY`. So this helper:
 *
 *   1. Picks a small-model provider by walking a priority list and
 *      returning the first one whose API key is present (`hasSecret`).
 *   2. Calls `provider.complete()` with a tightly-scoped system prompt
 *      that asks the model to ground its answer in the provided content.
 *   3. Falls back to a deterministic heuristic summary (truncated content
 *      + prompt restatement) when no provider is reachable — so the agent
 *      loop can keep moving in fully offline / unseeded environments.
 *
 * The provider order and small-model defaults can be overridden by the
 * `CHOVY_WEBFETCH_MODEL` / `CHOVY_WEBFETCH_PROVIDER` env vars (one shot,
 * no config-file plumbing yet — step-02 owns persistent settings).
 *
 * This module is deliberately tool-agnostic: future tools (e.g. step-11's
 * AskUserQuestion summarizer) can call `summarizeWithSmallModel` directly.
 */

import { hasSecret } from "../../config/secrets.js";
import { logger } from "../../logger/index.js";
import { getProvider } from "../../providers/index.js";
import type { ProviderId } from "../../types/index.js";

/** Per-provider default small / fast model id. Mirrors `docs/step-10 §2`. */
const SMALL_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  zai: "gpt-4o-mini",
  zhipu: "glm-4-flash",
  kimi: "moonshot-v1-8k",
  minimax: "abab6.5s-chat",
  alibaba: "qwen-turbo",
  anthropic: "claude-3-5-haiku-20241022",
  google: "gemini-2.5-flash",
  xai: "grok-2-1212",
  siliconflow: "THUDM/glm-4-9b-chat",
  stepfun: "step-3.5-flash",
};

/** Priority order for picking a small-model backend when nothing is set. */
const DEFAULT_PROVIDER_ORDER: ProviderId[] = [
  "openai",
  "zhipu",
  "deepseek",
  "zai",
  "kimi",
  "minimax",
  "alibaba",
];

export interface SummarizeOptions {
  /** Markdown content already converted from HTML / text. */
  content: string;
  /** The user's question / extraction target. */
  prompt: string;
  /** Optional cap on the content we send (defaults to 100 000 chars). */
  maxContentChars?: number;
  /** Honored by the provider call when supplied. */
  signal?: AbortSignal;
}

export interface SummarizeResult {
  text: string;
  /** `"provider:<id>"` or `"fallback:heuristic"`. */
  source: string;
}

const DEFAULT_MAX_CONTENT = 100_000;

function pickProvider(): ProviderId | undefined {
  const explicit = process.env.CHOVY_WEBFETCH_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    // Trust the user — even if `hasSecret` reports false the provider call
    // will throw a clean `PROVIDER_NOT_READY` and we'll fall back below.
    if ((DEFAULT_PROVIDER_ORDER as string[]).includes(explicit)) {
      return explicit as ProviderId;
    }
  }
  for (const id of DEFAULT_PROVIDER_ORDER) {
    if (hasSecret(id)) return id;
  }
  return undefined;
}

function pickModel(provider: ProviderId): string {
  const explicit = process.env.CHOVY_WEBFETCH_MODEL?.trim();
  if (explicit) return explicit;
  return SMALL_MODEL_BY_PROVIDER[provider];
}

function truncate(content: string, n: number): string {
  if (content.length <= n) return content;
  return content.slice(0, n) + "\n\n[Content truncated to " + n + " chars]";
}

/**
 * Build the secondary-model prompt. Mirrors cc-haha's
 * `makeSecondaryModelPrompt` for the non-preapproved case: ground in the
 * provided text, quote sparingly, never fabricate.
 */
function buildPrompt(content: string, userPrompt: string): string {
  return [
    "Web page content (markdown):",
    "---",
    content,
    "---",
    "",
    userPrompt,
    "",
    "Provide a concise response based only on the content above.",
    "Quote at most 125 characters from any single section.",
    "If the content does not answer the question, say so plainly.",
  ].join("\n");
}

const SYSTEM_PROMPT =
  "You are a careful web content summarizer. Ground every claim in the " +
  "provided markdown. Never invent URLs, names, or facts that are not " +
  "present in the source. Reply in the language of the user's question.";

/**
 * Last-resort summarizer: returns the user's prompt restated plus the
 * first ~2 KB of the content so the model loop has *something* to work
 * with even without API keys. This is the same posture as cc-haha's
 * `makeWebSearchUnavailableOutput`: be honest about the degradation.
 */
function heuristicSummary(prompt: string, content: string): string {
  const head = content.slice(0, 2_000).trim();
  const tail = content.length > 2_000 ? `\n\n[…truncated; total ${content.length} chars]` : "";
  return [
    "[No small-model provider reachable; returning raw extract.]",
    "",
    `Prompt: ${prompt}`,
    "",
    "Content head:",
    head || "(empty)",
    tail,
  ].join("\n");
}

/**
 * Run the user's prompt against the markdown using a small model. Falls
 * back to a heuristic extract when no provider is reachable so the agent
 * loop is never blocked on a missing key.
 */
export async function summarizeWithSmallModel(
  opts: SummarizeOptions,
): Promise<SummarizeResult> {
  const maxContent = opts.maxContentChars ?? DEFAULT_MAX_CONTENT;
  const trimmedContent = truncate(opts.content, maxContent);
  const userPrompt = buildPrompt(trimmedContent, opts.prompt);

  const providerId = pickProvider();
  if (!providerId) {
    logger.debug("web_fetch: no small-model provider available; using heuristic", {
      contentChars: opts.content.length,
    });
    return {
      text: heuristicSummary(opts.prompt, opts.content),
      source: "fallback:heuristic",
    };
  }

  const model = pickModel(providerId);
  try {
    const provider = getProvider(providerId);
    provider.assertReady();
    const completion = await provider.complete({
      model,
      messages: [{ role: "user", content: userPrompt }],
      systemPrompt: SYSTEM_PROMPT,
      // Conservative: small models do not need creativity here.
      temperature: 0.2,
      maxTokens: 1024,
      signal: opts.signal,
    });
    const text = completion.content?.trim() ?? "";
    if (!text) {
      // Some scaffold providers return placeholder strings; still better
      // than nothing for smoke tests, but flag it so the caller knows.
      return {
        text: heuristicSummary(opts.prompt, opts.content),
        source: "fallback:empty-response",
      };
    }
    return { text, source: `provider:${providerId}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("web_fetch: small-model provider failed; falling back", {
      provider: providerId,
      model,
      error: msg,
    });
    return {
      text: heuristicSummary(opts.prompt, opts.content),
      source: `fallback:provider-error:${providerId}`,
    };
  }
}
