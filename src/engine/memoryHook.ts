/**
 * TMT glue between QueryEngine and `src/memory/` (step-25/30).
 *
 * The store remains file-primary (`MEMORY.md`, `notes.md`, checkpoints,
 * progress). This helper syncs those files, selects relevant records under
 * the memory slab, and returns a ready-to-render `[memory]` block for the
 * prompt builder.
 */

import { logger } from "../logger/index.js";
import { buildMemoryPromptSegment } from "../memory/index.js";
import type { AgentRole, ChatMessage } from "../types/index.js";
import type { ChovyConfig } from "../config/config.js";

export interface MemoryRoundInput {
  messages: readonly ChatMessage[];
  agentRole: AgentRole;
  omitMemory?: boolean;
  cwd: string;
  cfg: ChovyConfig;
  goalObjective?: string;
}

export interface MemoryRoundOutcome {
  memoryText?: string;
  entries: number;
}

export async function runMemoryRound(
  input: MemoryRoundInput,
): Promise<MemoryRoundOutcome> {
  if (input.omitMemory || !input.cfg.memory.enabled) {
    return { entries: 0 };
  }
  try {
    const seg = await buildMemoryPromptSegment({
      cwd: input.cwd,
      messages: input.messages,
      budgetTokens: input.cfg.memory.injectBudgetTokens,
      enabled: input.cfg.memory.enabled,
      agentRole: input.agentRole,
      goalObjective: input.goalObjective,
    });
    return {
      memoryText: seg.text || undefined,
      entries: seg.entries,
    };
  } catch (err) {
    logger.warn("runMemoryRound failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { entries: 0 };
  }
}
