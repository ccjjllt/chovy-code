import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { runAgent } from "../agent/index.js";
import { getSubAgentPool } from "../agent/index.js";
import { listProviders } from "../providers/index.js";
import { logger } from "../logger/index.js";
import type { ProviderId } from "../types/index.js";
import type { PermissionMode } from "../config/index.js";
import { HeaderBar, type BudgetSnapshot, type SwarmSummary } from "./components/HeaderBar.js";
import { MessageList, type UIMessage } from "./components/MessageList.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { StatusLine } from "./components/StatusLine.js";
import { SwarmPanel } from "./components/SwarmPanel.js";
import { InputBox } from "./inputBox.js";
import { useSwarmState, swarmCounts } from "./state/swarmStore.js";
import {
  slashCommands,
  listSlashEntries,
  type ReplCtx,
} from "./slashCommands.js";

interface Props {
  provider: ProviderId;
  model: string;
  initialMode: PermissionMode;
}

let _idSeq = 0;
const newId = (): string => {
  _idSeq += 1;
  return `m_${Date.now().toString(36)}_${_idSeq}`;
};

/**
 * Interactive REPL screen.
 *
 * What lives here vs. step-XX:
 *   - input/output, slash dispatch, busy/cancel state — here (step-05)
 *   - real cost & ctx numbers in the header — step-16 / step-27
 *   - cancellation that actually stops the provider mid-stream — step-16/17
 *   - swarm panel, goal panel, hooks UI — step-22 / step-23 / step-13
 *
 * For step-05 we keep `runAgent` as-is; cancellation is implemented as a
 * local "drop tokens after this point" flag plus a UI `[interrupted]` mark.
 * The background request still completes (its result is ignored), which is
 * acceptable for a one-step CLI shell and gets upgraded once the engine
 * gains a proper AbortSignal in step-16.
 */
export function ChovyRepl({ provider, model, initialMode }: Props): React.ReactElement {
  const { exit } = useApp();

  const [messages, setMessages] = useState<UIMessage[]>(() => [{
    id: newId(),
    role: "system",
    content:
      `chovy-code REPL · provider=${provider} · model=${model}\n` +
      "输入 /help 查看斜杠命令；Esc 中断运行；连按两次 Ctrl+C 退出；Shift+Enter 换行。",
  }]);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<PermissionMode>(initialMode);
  const [helpOpen, setHelpOpen] = useState(false);
  const [goal, setGoal] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // Budget is a placeholder until step-16/27 wire real numbers.
  const [budget] = useState<BudgetSnapshot>({
    costUSD: 0,
    ctxUsedTokens: 0,
    ctxTotalTokens: 0,
  });

  const cancelledRef = useRef(false);
  const ctrlCArmedRef = useRef(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // step-22: live sub-agent state for the SwarmPanel + HeaderBar chip.
  // `CHOVY_NO_SWARM_PANEL=1` disables the panel entirely (Windows ConHost
  // flicker workaround per spec §风险); the header chip still reflects
  // counts so the user knows sub-agents are running.
  const swarm = useSwarmState();
  const panelDisabled = process.env["CHOVY_NO_SWARM_PANEL"] === "1";
  const showPanel = !panelDisabled && swarm.agents.length > 0;
  const [panelFocused, setPanelFocused] = useState(false);
  const swarmSummary: SwarmSummary | undefined = swarm.agents.length > 0
    ? swarmCounts(swarm.agents)
    : undefined;

  // Tab toggles focus between InputBox and SwarmPanel. When the panel isn't
  // visible, focus stays on input. Tab is captured only when not busy so
  // mid-run tabbing doesn't disrupt the input box.
  useInput(
    (input, key) => {
      if (input !== "t" && !key.tab) return;
      // Require the raw Tab key (Ink delivers it as key.tab with empty input
      // on most terminals); accept "t" only when ctrl is held as a fallback.
      if (!key.tab && !(key.ctrl && input === "t")) return;
      if (busy) return;
      setPanelFocused((v) => !v);
    },
    { isActive: showPanel && !busy },
  );

  // If the panel disappears (pool drained), drop focus back to input so the
  // user isn't stuck in a focused-but-invisible state.
  useEffect(() => {
    if (!showPanel && panelFocused) setPanelFocused(false);
  }, [showPanel, panelFocused]);

  const appendSystem = useCallback((content: string) => {
    setMessages((xs) => [...xs, { id: newId(), role: "system", content }]);
  }, []);

  const ctx: ReplCtx = useMemo(() => ({
    setMode: (m) => setMode(m),
    appendSystem,
    clearMessages: () => setMessages([]),
    toggleHelp: (show) => setHelpOpen((v) => (show ?? !v)),
    setGoal: (g) => setGoal(g),
    exit: () => exit(),
    listProviders: () => listProviders().map((p) => p.info.id),
    // step-22: format the live pool handles for /agents. One line per
    // handle with id / role / status / phase / cost, so the user can
    // inspect without opening the panel (non-TTY friendly).
    listAgents: () => {
      const xs = getSubAgentPool().list();
      if (xs.length === 0) return [];
      return xs.map((h) => {
        const cost = `$${(h.costUSD ?? 0).toFixed(4)}`;
        return `${h.id}  ${h.role.padEnd(8)}  ${h.status.padEnd(9)}  ${h.phase}  ${cost}`;
      });
    },
    listSkills: () => [], // TODO step-29
  }), [appendSystem, exit]);

  const runSlash = useCallback(async (line: string): Promise<void> => {
    const trimmed = line.replace(/^\//, "");
    const sp = trimmed.indexOf(" ");
    const name = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? "" : trimmed.slice(sp + 1);

    setMessages((xs) => [...xs, { id: newId(), role: "user", content: line }]);

    const entry = slashCommands[name];
    if (!entry) {
      appendSystem(`未知斜杠命令：/${name}（试试 /help）`);
      return;
    }
    try {
      await entry.handler(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendSystem(`/${name} 执行失败：${msg}`);
    }
  }, [appendSystem, ctx]);

  const send = useCallback(async (text: string): Promise<void> => {
    const t = text.trim();
    if (t.length === 0) return;

    // Push to history (dedupe last entry).
    setHistory((h) => (h[h.length - 1] === t ? h : [...h, t]));

    if (t.startsWith("/")) { await runSlash(t); return; }

    // Real prompt → run the agent.
    const userId = newId();
    const assistantId = newId();
    setMessages((xs) => [
      ...xs,
      { id: userId, role: "user", content: t },
      { id: assistantId, role: "assistant", content: "", pending: true },
    ]);
    setBusy(true);
    setTool(undefined);
    cancelledRef.current = false;

    try {
      let buf = "";
      const final = await runAgent(t, {
        provider,
        model,
        permissionMode: mode,
        onToken: (delta) => {
          if (cancelledRef.current) return;
          buf += delta;
          setMessages((xs) =>
            xs.map((m) => (m.id === assistantId ? { ...m, content: buf } : m)),
          );
        },
        onToolCall: (name) => {
          if (cancelledRef.current) return;
          setTool(name);
        },
      });
      if (cancelledRef.current) {
        setMessages((xs) => xs.map((m) =>
          m.id === assistantId
            ? { ...m, pending: false, interrupted: true, content: m.content || "(已中断)" }
            : m,
        ));
      } else {
        const finalText = buf.length > 0 ? buf : final;
        setMessages((xs) => xs.map((m) =>
          m.id === assistantId ? { ...m, pending: false, content: finalText } : m,
        ));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(msg);
      setMessages((xs) => xs.map((m) =>
        m.id === assistantId ? { ...m, pending: false, content: `Error: ${msg}` } : m,
      ));
    } finally {
      setBusy(false);
      setTool(undefined);
    }
  }, [model, provider, runSlash]);

  const onCancel = useCallback(() => {
    if (busy) {
      cancelledRef.current = true;
      appendSystem("已请求取消当前运行（Esc）。");
    }
  }, [busy, appendSystem]);

  const onCtrlC = useCallback(() => {
    if (busy) {
      // First Ctrl+C while busy → interrupt; do NOT exit.
      cancelledRef.current = true;
      appendSystem("已中断当前运行。再次按 Ctrl+C 可退出 REPL。");
      ctrlCArmedRef.current = true;
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = setTimeout(() => { ctrlCArmedRef.current = false; }, 1500);
      return;
    }
    if (ctrlCArmedRef.current) {
      exit();
      return;
    }
    ctrlCArmedRef.current = true;
    appendSystem("再次按 Ctrl+C 退出（或 /quit）。");
    if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
    ctrlCTimerRef.current = setTimeout(() => { ctrlCArmedRef.current = false; }, 1500);
  }, [busy, appendSystem, exit]);

  useEffect(() => () => {
    if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
  }, []);

  return (
    <Box flexDirection="column">
      <HeaderBar
        mode={mode}
        provider={provider}
        model={model}
        budget={budget}
        swarm={swarmSummary}
      />

      {goal ? (
        <Box paddingX={1}>
          <Text color="magenta" bold>{`/goal `}</Text>
          <Text>{goal}</Text>
          <Text dimColor>{"  (TODO step-23)"}</Text>
        </Box>
      ) : null}

      <MessageList messages={messages} />

      {helpOpen ? (
        <Box marginTop={1}>
          <HelpOverlay entries={listSlashEntries()} />
        </Box>
      ) : null}

      {busy ? (
        <Box marginTop={1}>
          <StatusLine status={tool ? "tool" : "thinking"} tool={tool} />
        </Box>
      ) : null}

      {showPanel ? (
        <Box marginTop={1}>
          <SwarmPanel
            agents={swarm.agents}
            budget={{ spent: swarm.budget.costUSD }}
            focused={panelFocused}
            onClose={() => setPanelFocused(false)}
            onGoalToggle={() => setGoal((g) => (g ? null : "(toggle via panel)"))}
          />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <InputBox
          disabled={busy}
          history={history}
          onSubmit={send}
          onCancel={onCancel}
          onCtrlC={onCtrlC}
        />
      </Box>
      {panelFocused ? (
        <Text dimColor>{"  (panel focused — Tab to return to input)"}</Text>
      ) : null}
    </Box>
  );
}
