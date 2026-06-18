/**
 * Static / dynamic boundary marker (step-15).
 *
 * `CHOVY_PROMPT_DYNAMIC_BOUNDARY` slices a system prompt into two halves:
 *   - everything *before* it MUST be stable (identity, tool norms, safety,
 *     style) — `staticHash` is computed over this prefix.
 *   - everything *after* it is per-session (cwd / git / memory / model
 *     info / loaded skills / context budget) — `dynamicHash` covers it.
 *
 * Why a string sentinel (rather than two arrays):
 *   1. The default prompt template is a single Markdown blob authored in
 *      `default.ts`; embedding a marker keeps the blob legible and avoids
 *      forcing every editor/reviewer to chase across multiple files.
 *   2. Anthropic-style prompt cache providers can pin `cache_control` at
 *      this exact byte offset (when step-17's PCM declares `promptCache`).
 *      Other providers benefit from "stable prefix → stable output style"
 *      without needing the cache feature itself.
 *
 * The marker is a literal HTML comment so it never accidentally appears in
 * a model's reply (and is harmless if a provider strips comments).
 */
export const CHOVY_PROMPT_DYNAMIC_BOUNDARY = "<!--chovy:dynamic-->";

/**
 * Split a fully-assembled prompt at the boundary marker. When the marker is
 * absent (e.g. `override` layer was used), the entire prompt counts as
 * static and `dynamic` is empty — that mirrors cc-haha's fallback and
 * keeps PSF stable for override-only flows.
 */
export function splitAtBoundary(text: string): { static: string; dynamic: string } {
  const idx = text.indexOf(CHOVY_PROMPT_DYNAMIC_BOUNDARY);
  if (idx < 0) return { static: text, dynamic: "" };
  return {
    static: text.slice(0, idx),
    dynamic: text.slice(idx + CHOVY_PROMPT_DYNAMIC_BOUNDARY.length),
  };
}
