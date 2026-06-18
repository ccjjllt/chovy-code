import React, { useState } from "react";
import { Box, Text, useApp } from "ink";
import { runAgent } from "../../agent/index.js";
import type { ProviderId } from "../../types/index.js";
import { StatusLine, type AgentStatus } from "./StatusLine.js";

interface Props {
  prompt: string;
  provider: ProviderId;
  model?: string;
}

/**
 * One-shot agent view: shows a status line while the agent runs, then prints
 * the streamed answer. The Ink render exits the process when the run finishes
 * via useApp().exit().
 *
 * (An interactive REPL — multiple turns, input box — can layer on top of this
 * later; for now we run a single prompt to prove the wiring end to end.)
 */
export function AgentRepl({ prompt, provider, model }: Props): React.ReactElement {
  const { exit } = useApp();
  const [status, setStatus] = useState<AgentStatus>("thinking");
  const [answer, setAnswer] = useState("");
  const [tool, setTool] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  React.useEffect(() => {
    let cancelled = false;
    let buf = "";

    runAgent(prompt, {
      provider,
      model,
      onToken: (delta) => {
        if (cancelled) return;
        buf += delta;
        setAnswer(buf);
      },
      onToolCall: (name) => {
        if (cancelled) return;
        setTool(name);
        setStatus("tool");
      },
    })
      .then((final) => {
        if (cancelled) return;
        // Prefer the streamed buffer; fall back to the final answer.
        setAnswer(buf || final);
        setStatus("done");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      })
      .finally(() => {
        // Give the terminal a beat to render before exiting.
        setTimeout(() => exit(), 50);
      });

    return () => {
      cancelled = true;
    };
  }, [prompt, provider, model, exit]);

  // ctrl+c handled by render({ exitOnCtrlC: true }) in TTY mode; the
  // process also self-exits when the run completes (see .finally above).

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text dimColor>chovy ❯ </Text>
        <Text>{prompt}</Text>
      </Box>

      {status !== "done" && status !== "error" && (
        <StatusLine status={status} tool={tool} />
      )}

      {answer.length > 0 && (
        <Text>{answer}</Text>
      )}

      {error && <Text color="red">Error: {error}</Text>}
    </Box>
  );
}
