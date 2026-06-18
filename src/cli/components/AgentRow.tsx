import React from "react";
import { Box, Text } from "ink";
import type { SubAgentHandle } from "../../types/index.js";

interface Props {
  handle: SubAgentHandle;
  selected: boolean;
  now: number;
}

/**
 * Color per lifecycle status. Matches the visual language of StatusLine:
 * running/queued = cyan (active), terminal-ok = green, terminal-bad = red,
 * cancelled = yellow, paused = magenta.
 */
const STATUS_COLOR: Record<SubAgentHandle["status"], string> = {
  queued: "gray",
  running: "cyan",
  paused: "magenta",
  done: "green",
  failed: "red",
  cancelled: "yellow",
};

/** Glyph shown in the left gutter. `▶` for active, space for terminal. */
function statusGlyph(status: SubAgentHandle["status"]): string {
  switch (status) {
    case "running":
    case "queued":
    case "paused":
      return "▶";
    default:
      return " ";
  }
}

/** Result glyph + short label for terminal rows (✅ / ❌ / ⏹). */
function resultMark(handle: SubAgentHandle): { glyph: string; label: string } {
  switch (handle.status) {
    case "done":
      return { glyph: "✅", label: "DONE" };
    case "failed":
      return {
        glyph: "❌",
        label: handle.result?.reason
          ? truncate(handle.result.reason, 28)
          : "failed",
      };
    case "cancelled":
      return { glyph: "⏹", label: "cancelled" };
    default:
      return { glyph: "", label: "" };
  }
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Format elapsed ms as MmSSs or just Ns when under a minute. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s).padStart(2, "0")}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, "0")}s`;
}

/**
 * One row in the SwarmPanel. Renders:
 *   ▶ sa_a1b2 explore   ⏳ reading file foo.ts          12s  $0.02
 *     sa_g7h8 verify    ✅ PASS                         07s  $0.01
 *
 * The phase column truncates to keep the row on one terminal line; the
 * elapsed/cost suffix is right-aligned-ish via fixed-width padding. `now`
 * is injected so elapsed time ticks without each row owning a timer.
 */
export function AgentRow({ handle, selected, now }: Props): React.ReactElement {
  const color = STATUS_COLOR[handle.status];
  const glyph = statusGlyph(handle.status);
  const sel = selected ? "❯" : " ";
  const id = handle.id;
  const role = handle.role.padEnd(8).slice(0, 8);

  const end = handle.finishedAt ?? now;
  const elapsed = formatElapsed(end - handle.spawnedAt);
  const cost = `$${(handle.costUSD ?? 0).toFixed(3)}`;

  // Active rows show the live phase; terminal rows show the result mark.
  let phaseOrResult: string;
  if (handle.status === "running" || handle.status === "queued" || handle.status === "paused") {
    const phaseLabel = handle.phase && handle.phase !== handle.status
      ? `⏳ ${truncate(handle.phase, 30)}`
      : "⏳ working";
    phaseOrResult = phaseLabel;
  } else {
    const mark = resultMark(handle);
    phaseOrResult = mark.glyph ? `${mark.glyph} ${mark.label}` : handle.phase;
  }

  return (
    <Box>
      <Text color={color}>{sel}</Text>
      <Text color={color} bold>{glyph} </Text>
      <Box width={12}>
        <Text color="gray">{id}</Text>
      </Box>
      <Box width={9}>
        <Text color={color}>{role}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={color}>{phaseOrResult}</Text>
      </Box>
      <Box width={6}>
        <Text dimColor>{elapsed}</Text>
      </Box>
      <Box width={8}>
        <Text dimColor>{cost}</Text>
      </Box>
    </Box>
  );
}
