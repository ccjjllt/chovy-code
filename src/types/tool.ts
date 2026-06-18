import type { z } from "zod";

/**
 * A tool the agent can invoke. Each tool declares its argument schema (zod)
 * and an async `run` handler. Tools are registered in `src/tools/index.ts`.
 */
export interface Tool<T extends z.ZodType = z.ZodType> {
  /** Stable, unique name. The model uses this to call the tool. */
  name: string;
  /** One-line description shown to the model. */
  description: string;
  /** Zod schema describing the tool's arguments. */
  schema: T;
  /** Execute the tool. Return a string result for the model. */
  run(args: z.infer<T>): Promise<string>;
}

/** Minimal description handed to providers that want a JSON-schema-like shape. */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}
