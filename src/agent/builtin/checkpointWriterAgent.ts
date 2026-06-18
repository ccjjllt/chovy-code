/**
 * CheckpointWriter agent — structured session checkpoints (step-19 stub).
 *
 * Placeholder role: the *interface* is frozen at step-19 (so step-26 can
 * wire it without touching types), but the system prompt and path-sandbox
 * are deliberately thin. Step-26 fills in:
 *   - the exact checkpoint template (≤8KB, sections per step-26 spec),
 *   - the path restriction to `~/.chovy/projects/<hash>/checkpoints/`
 *     (enforced by the permission/sandbox layer, not by this definition),
 *   - the SCW trigger that spawns this agent.
 *
 * The role is NOT reachable from the `agent` meta tool today (its
 * `subagent_type` enum only lists Explore/Plan/Verify/Critic) — step-26 / SCW
 * will spawn it directly via `pool.spawn({ role: "checkpoint-writer" })`.
 */
import type { BuiltInAgentDefinition } from "../../types/index.js";
import type { SystemContext } from "../../prompts/index.js";

export const checkpointWriterAgent: BuiltInAgentDefinition = {
  role: "checkpoint-writer",
  whenToUse:
    "Maintain structured session checkpoints. Spawned by SCW (step-26/27) when " +
    "context approaches the rebuild threshold — NOT user-facing. Writes a " +
    "compact summary to ~/.chovy/projects/<hash>/checkpoints/.",
  description: "Checkpoint writer (read/write); small model; step-26 finalizes.",

  // Whitelist: only read + write. The path restriction (checkpoints/ only) is
  // enforced by the permission/sandbox layer in step-26, not here — a role
  // definition can't express path predicates, and faking it in the prompt is
  // not a security boundary.
  allowedTools: ["file_read", "file_write"],

  preferredModel: "gpt-4o-mini", // small model — checkpointing is mechanical

  omitMemory: true, // least-context: the checkpoint IS the memory snapshot

  budgetUSD: 0.05,
  timeoutMs: 30_000,
  maxRounds: 4,

  getSystemPrompt(ctx: SystemContext): string {
    return [
      "你是 **CheckpointWriter** agent（占位，step-26 详化）。",
      "",
      "职责：把当前会话的关键状态压缩成一份结构化 checkpoint，写入",
      "`~/.chovy/projects/<hash>/checkpoints/<timestamp>.md`。",
      `- Working directory: ${ctx.cwd.cwd}。`,
      "",
      "TODO step-26: 填入完整模板（目标 / 进度 / 决策 / 未决问题 / 文件变更），",
      "并收紧写路径到 checkpoints/ 目录（由权限/沙箱层强制，非此 prompt）。",
      "",
      "当前约束（占位）：",
      "- 输出 ≤ 8KB。",
      "- 只用 `file_read`（读上下文）+ `file_write`（写 checkpoint）。",
      "- 不要改动 checkpoint 目录之外的任何文件。",
    ].join("\n");
  },
};
