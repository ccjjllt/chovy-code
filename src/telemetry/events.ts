/**
 * Telemetry event types.
 *
 * Step-03 freezes the event union shape. Later steps will fill in the
 * placeholder cross-module types (AgentRole / PromptShape) once their
 * owning steps land.
 */

// TODO step-19: replace with AgentRole exported from src/agent/lifecycle.ts.
//   We accept `string & {}` so unknown roles still type-check while the real
//   union is being shaped.
export type AgentRole =
  | "main"
  | "explore"
  | "plan"
  | "verify"
  | "critic"
  | "checkpoint-writer"
  | (string & {});

// TODO step-15: replace with PromptShape exported from src/prompts/fingerprint.ts.
export interface PromptShape {
  /** Stable hash over the assembled system prompt layers. */
  hash: string;
  /** Number of layers participating in the build. */
  layers: number;
  /** Total tokens (estimated) of the final prompt. */
  tokens: number;
}

export type TelemetryEvent =
  | { type: "agent.start"; agentId: string; role: AgentRole; ts: number }
  | { type: "agent.end"; agentId: string; status: string; costUSD: number; ts: number }
  | { type: "tool.call"; tool: string; ok: boolean; durMs: number; ts: number }
  | { type: "context.threshold"; level: "soft" | "hard"; tokens: number; ts: number }
  | { type: "goal.iteration"; round: number; converged: boolean; ts: number }
  | { type: "memory.injection"; bytes: number; entries: number; ts: number }
  | { type: "swarm.dispatch"; n: number; parallelism: number; ts: number }
  | { type: "prompt.shape"; shape: PromptShape; ts: number };

/** Type of an event with `ts` filled in by the sink (so callers can omit it). */
export type TelemetryEventInput = TelemetryEvent extends infer T
  ? T extends { ts: number }
    ? Omit<T, "ts">
    : never
  : never;
