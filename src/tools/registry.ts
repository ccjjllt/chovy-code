import type { Tool, ToolDescriptor } from "../types/index.js";

/**
 * In-process tool registry. Tools register themselves at import time
 * (see `src/tools/index.ts`). The agent loop looks tools up by name to
 * execute the model's tool calls.
 */
const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (tools.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  tools.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function listTools(): Tool[] {
  return [...tools.values()];
}

/** Convert registered tools into the descriptor shape handed to providers. */
export function describeTools(names?: string[]): ToolDescriptor[] {
  const all = listTools();
  const selected = names ? all.filter((t) => names.includes(t.name)) : all;
  return selected.map((t) => ({
    name: t.name,
    description: t.description,
    // Zod schemas expose a JSON-Schema-ish shape via .toJSON(); providers can
    // translate further as needed.
    schema: (t.schema as unknown as { toJSON?: () => Record<string, unknown> })
      .toJSON?.() ?? { type: "object" },
  }));
}
