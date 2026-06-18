import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { SubAgentHandle } from "../../types/index.js";
import { getOutput } from "../../agent/outputBuffer.js";
import { HotkeyBar } from "./HotkeyBar.js";

interface Props {
  handle: SubAgentHandle;
  /** Re-render tick so the elapsed counter + live output refresh. */
  now: number;
}

/**
 * Detail overlay for a single sub-agent (spec §详情浮层). Shows the full
 * handle metadata + a live preview of the streamed output (from the
 * outputBuffer ring). The parent SwarmPanel owns the `[c] [s] [Esc]`
 * hotkeys via its own `useInput` (activated while this overlay is open);
 * this component is purely presentational.
 *
 * The output preview is pulled (not pushed) every 200ms via a local tick,
 * matching the spec's "detail 面板主动 pull (每 200ms)" — cheap and keeps
 * the preview fresh even when no bus event fires.
 */
export function AgentDetail({ handle, now }: Props): React.ReactElement {
  const PREVIEW_LINES = 6;
  const PREVIEW_CHARS = 60;
  // Local 200ms tick for the output preview pull (spec §性能).
  const [outputTick, setOutputTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setOutputTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, []);
  // Touch `outputTick` so the linter doesn't flag it unused; the re-render
  // is the side-effect we want (re-reads getOutput below).
  void outputTick;

  const output = getOutput(handle.id);
  const previewLines = previewToLines(output, PREVIEW_LINES, PREVIEW_CHARS);

  const end = handle.finishedAt ?? now;
  const elapsedMs = end - handle.spawnedAt;
  const provider = handle.provider ?? "(parent)";
  const model = handle.model ?? "(parent)";
  const cost = `$${(handle.costUSD ?? 0).toFixed(4)}`;
  const tokensIn = handle.tokensIn.toLocaleString();
  const tokensOut = handle.tokensOut.toLocaleString();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">{`${handle.id} / ${handle.role} agent`}</Text>
      </Box>
      <Box>
        <Text dimColor>{"provider: "}</Text>
        <Text>{provider}</Text>
        <Text dimColor>{"    model: "}</Text>
        <Text>{model}</Text>
      </Box>
      <Box>
        <Text dimColor>{"status: "}</Text>
        <Text color={statusColor(handle.status)} bold>{handle.status}</Text>
        <Text dimColor>{"    phase: "}</Text>
        <Text>{handle.phase}</Text>
      </Box>
      <Box>
        <Text dimColor>{"tokens: in "}</Text>
        <Text>{tokensIn}</Text>
        <Text dimColor>{" / out "}</Text>
        <Text>{tokensOut}</Text>
        <Text dimColor>{"    cost: "}</Text>
        <Text>{cost}</Text>
        <Text dimColor>{"    elapsed: "}</Text>
        <Text dimColor>{formatElapsed(elapsedMs)}</Text>
      </Box>

      {handle.prompt ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor bold>{"prompt:"}</Text>
          <Box paddingLeft={2}>
            <Text wrap="truncate">{truncate(handle.prompt, 200)}</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor bold>{"Last output (preview):"}</Text>
        {previewLines.length > 0 ? (
          <Box paddingLeft={2} flexDirection="column">
            {previewLines.map((line, i) => (
              <Text key={i} wrap="truncate">{line}</Text>
            ))}
          </Box>
        ) : (
          <Box paddingLeft={2}>
            <Text dimColor>{"(no output yet)"}</Text>
          </Box>
        )}
      </Box>

      {handle.result?.reason ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor bold>{"result:"}</Text>
          <Box paddingLeft={2}>
            <Text color="yellow" wrap="truncate">{handle.result.reason}</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <HotkeyBar detailMode />
      </Box>
    </Box>
  );
}

function statusColor(status: SubAgentHandle["status"]): string {
  switch (status) {
    case "running":
      return "cyan";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "cancelled":
      return "yellow";
    case "paused":
      return "magenta";
    default:
      return "white";
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Split the (possibly long) output buffer into the last N non-empty lines,
 *  each truncated to `lineChars`. We show the tail because that's the
 *  "live" portion a user inspecting a running agent cares about. */
function previewToLines(buffer: string, maxLines: number, lineChars: number): string[] {
  if (!buffer) return [];
  const lines = buffer.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines);
  return tail.map((l) => truncate(l, lineChars));
}
