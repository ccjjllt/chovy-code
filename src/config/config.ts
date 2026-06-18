import { z } from "zod";

/**
 * Runtime configuration. Loaded from env vars first, then optionally merged
 * with a JSON config file (`~/.chovy/config.json`) in a later iteration.
 *
 * For now we keep it deliberately minimal — read what we need, validate,
 * expose a typed object.
 */
const ConfigSchema = z.object({
  provider: z
    .enum(["openai", "anthropic", "gemini", "deepseek", "minimax", "glm", "kimi"])
    .default("openai"),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().default(0.2),
  maxTokens: z.number().default(4096),
  verbose: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Read configuration from the environment. Throws on invalid combinations. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.parse({
    provider: env.CHOVY_PROVIDER,
    model: env.CHOVY_MODEL,
    apiKey: env.CHOVY_API_KEY,
    temperature: env.CHOVY_TEMPERATURE ? Number(env.CHOVY_TEMPERATURE) : undefined,
    maxTokens: env.CHOVY_MAX_TOKENS ? Number(env.CHOVY_MAX_TOKENS) : undefined,
    verbose: env.CHOVY_VERBOSE === "1" || env.CHOVY_VERBOSE === "true",
  });
  return parsed;
}
