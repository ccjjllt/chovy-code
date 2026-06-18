import { registerTool } from "./registry.js";
import { echoTool } from "./echo.js";
import {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
} from "./fs/index.js";
import { bashTool } from "./exec/index.js";
import { webFetchTool, webSearchTool } from "./web/index.js";

/**
 * Built-in tool registration (step-06).
 *
 * Each built-in tool is registered with its namespace so step-07's ATP
 * allocator and step-12's permission engine can filter/group them. New
 * built-ins land in `src/tools/<namespace>/` per `architecture.md §1`.
 */
registerTool(echoTool, { namespace: "meta" });

// step-08: filesystem tools.
registerTool(fileReadTool, { namespace: "fs" });
registerTool(fileWriteTool, { namespace: "fs" });
registerTool(fileEditTool, { namespace: "fs" });
registerTool(globTool, { namespace: "fs" });
registerTool(grepTool, { namespace: "fs" });

// step-09: bash executor.
registerTool(bashTool, { namespace: "exec" });

// step-10: web tools (WebFetch / WebSearch).
registerTool(webFetchTool, { namespace: "web" });
registerTool(webSearchTool, { namespace: "web" });

// ── Public surface ─────────────────────────────────────────────────────────

export {
  getTool,
  listTools,
  registerTool,
  resetToolRegistry,
  namespaceOf,
  describeToolsLegacy,
} from "./registry.js";
export type { RegisterOptions, ListFilter } from "./registry.js";

// ATP-aware describer (step-06 freezes the signature; step-07 fills it out).
export { describeTools } from "./describe.js";
export type { DescribeOptions, DescribedTool } from "./describe.js";
