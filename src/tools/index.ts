import { registerTool } from "./registry.js";
import { echoTool } from "./echo.js";

// Register every built-in tool. Add new tools here as you implement them.
registerTool(echoTool);

export { getTool, listTools, describeTools } from "./registry.js";
