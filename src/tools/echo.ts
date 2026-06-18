import { z } from "zod";
import type { Tool } from "../types/index.js";

/** Trivial reference tool — echoes back what it's given. Useful for wiring
 *  smoke tests of the agent loop before real tools land. */
export const echoTool: Tool = {
  name: "echo",
  description: "Echo back the provided message. A no-op tool for testing the agent loop.",
  schema: z.object({
    message: z.string().describe("The text to echo back."),
  }),
  async run(args) {
    return args.message;
  },
};
