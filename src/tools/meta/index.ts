/**
 * Meta tools barrel (step-11).
 *
 * Exposes the four built-in meta tools — tools that change *how* the agent
 * works rather than mutating the world directly:
 *
 *   - `todoWriteTool`      — `todo_write`, agent-maintained task list
 *   - `askUserQuestionTool`— `ask_user_question`, interactive multiple-choice
 *   - `skillTool`          — `skill`, stub → step-29 (CSG)
 *   - `agentTool`          — `agent`, stub → step-18 (SwarmR runtime)
 *
 * Registration with the global registry happens in `src/tools/index.ts`
 * (namespace `"meta"`) so consumers of `listTools()` see these alongside
 * fs/exec/web without an extra import. The `readTodoList` helper is exported
 * for the step-22 TodoPanel UI.
 */

export { todoWriteTool, readTodoList, _resetTodoStoreForTesting } from "./todoWrite.js";
export { askUserQuestionTool } from "./askUserQuestion.js";
export { skillTool } from "./skill.js";
export { agentTool } from "./agent.js";
