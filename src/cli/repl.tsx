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
import { GoalPanel } from "./components/GoalPanel.js";
import { InputBox } from "./inputBox.js";
import { useSwarmState, swarmCounts } from "./state/swarmStore.js";
import {
  slashCommands,
  listSlashEntries,
  type ReplCtx,
  type ReplGoalRuntime,
} from "./slashCommands.js";
import {
  createGoal,
  finalizeGoal,
  listGoals,
  runGoal,
  type CreateGoalInput,
  type RunGoalResult,
} from "../goals/index.js";
import type { GoalState } from "../types/index.js";

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
 * step-23 additions:
 *   - GoalPanel mounts whenever `goalState` is non-null;
 *   - Tab cycles focus between input ↔ swarm panel ↔ goal panel (only the
 *     panels that are visible are part of the cycle);
 *   - the slash handler `/goal` receives a `ReplGoalRuntime` that wraps
 *     `createGoal` + `runGoal` with the REPL's provider/model/cwd, so
 *     `cli/slashCommands/goal.ts` stays UI-only.
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
  const [goalState, setGoalState] = useState<GoalState | null>(null);
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

  // step-23: per-REPL goal-loop AbortController. Nullable — created on
  // /goal start, replaced on resume, dropped on completion.
  const goalAcRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string>(`thread_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);

  // step-22: live sub-agent state for the SwarmPanel + HeaderBar chip.
  const swarm = useSwarmState();
  const panelDisabled = process.env["CHOVY_NO_SWARM_PANEL"] === "1";
  const showSwarmPanel = !panelDisabled && swarm.agents.length > 0;
  const showGoalPanel = !panelDisabled && goalState !== null;
  const swarmSummary: SwarmSummary | undefined = swarm.agents.length > 0
    ? swarmCounts(swarm.agents)
    : undefined;

  // 3-way focus cycle: "input" → "swarm" → "goal" → "input". Only visible
  // panels participate. Hotkey: Tab when not busy.
  type Focus = "input" | "swarm" | "goal";
  const [focus, setFocus] = useState<Focus>("input");

  useInput(
    (_input, key) => {
      if (!key.tab) return;
      if (busy) return;
      const ring: Focus[] = ["input"];
      if (showSwarmPanel) ring.push("swarm");
      if (showGoalPanel) ring.push("goal");
      if (ring.length <= 1) return;
      const idx = ring.indexOf(focus);
      const next = ring[(idx + 1) % ring.length] ?? "input";
      setFocus(next);
    },
    { isActive: !busy },
  );

  // Drop focus back to input if the panel we were focused on disappears.
  useEffect(() => {
    if (focus === "swarm" && !showSwarmPanel) setFocus("input");
    if (focus === "goal" && !showGoalPanel) setFocus("input");
  }, [focus, showSwarmPanel, showGoalPanel]);

  const appendSystem = useCallback((content: string) => {
    setMessages((xs) => [...xs, { id: newId(), role: "system", content }]);
  }, []);

  // ── step-23: REPL goal-loop runtime injected into ReplCtx.goal ──────────
  const goalRuntime: ReplGoalRuntime = useMemo(() => ({
    threadId: threadIdRef.current,
    cwd: process.cwd(),
    startGoal: async (input: CreateGoalInput): Promise<GoalState> => {
      // Create + persist + start the loop; the loop runs in the background
      // and updates `goalState` via the `onRound` callback.
      const goal = createGoal(input);
      setGoalState({ ...goal });
      goalAcRef.current = new AbortController();
      void runGoal(goal, {
        cwd: process.cwd(),
        provider,
        model,
        permissionMode: mode,
        abortSignal: goalAcRef.current.signal,
        onRound: (g) => {
          // Snapshot the mutating reference so React re-renders.
          setGoalState({ ...g });
        },
        onConvergenceCheck: (g, ok, reasons) => {
          appendSystem(
            ok
              ? `[goal] round ${g.rounds} ✓ converged`
              : `[goal] round ${g.rounds} not yet — ${reasons.slice(0, 2).join("; ")}`,
          );
        },
        onHookMessage: appendSystem,
      })
        .then((res: RunGoalResult) => {
          setGoalState({ ...res.goal });
          appendSystem(
            `[goal] ${res.goal.status} after ${res.rounds} round(s); cost $${res.costUSD.toFixed(4)}`,
          );
          // Drop the in-memory goal once truly terminal so the panel hides.
          // `paused` stays so the user can /goal resume.
          if (
            res.goal.status === "achieved" ||
            res.goal.status === "failed" ||
            res.goal.status === "cancelled"
          ) {
            setGoalState(null);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(msg);
          appendSystem(`[goal] error: ${msg}`);
        });
      return goal;
    },
    cancelGoal: () => {
      goalAcRef.current?.abort();
      goalAcRef.current = null;
    },
    resumeGoalLoop: async (goal: GoalState): Promise<RunGoalResult> => {
      goalAcRef.current = new AbortController();
      setGoalState({ ...goal });
      const res = await runGoal(goal, {
        cwd: process.cwd(),
        provider,
        model,
        permissionMode: mode,
        abortSignal: goalAcRef.current.signal,
        onRound: (g) => setGoalState({ ...g }),
        onHookMessage: appendSystem,
      });
      setGoalState({ ...res.goal });
      if (
        res.goal.status === "achieved" ||
        res.goal.status === "failed" ||
        res.goal.status === "cancelled"
      ) {
        setGoalState(null);
      }
      return res;
    },
    findPausedGoal: async (): Promise<GoalState | null> => {
      const all = await listGoals(process.cwd());
      const paused = all.find(
        (g) => g.threadId === threadIdRef.current && g.status === "paused",
      ) ?? all.find((g) => g.status === "paused");
      return paused ?? null;
    },
    setReplGoal: (g) => setGoalState(g ? { ...g } : null),
  }), [appendSystem, mode, model, provider]);

  const ctx: ReplCtx = useMemo(() => ({
    setMode: (m) => setMode(m),
    appendSystem,
    clearMessages: () => setMessages([]),
    toggleHelp: (show) => setHelpOpen((v) => (show ?? !v)),
    setGoal: (g) => {
      // Legacy slot preserved for non-/goal callers; step-23 routes through
      // `goal.setReplGoal` instead. Keep this so old handlers keep working.
      if (g === null) setGoalState(null);
    },
    exit: () => exit(),
    listProviders: () => listProviders().map((p) => p.info.id),
    listAgents: () => {
      const xs = getSubAgentPool().list();
      if (xs.length === 0) return [];
      return xs.map((h) => {
        const cost = `$${(h.costUSD ?? 0).toFixed(4)}`;
        return `${h.id}  ${h.role.padEnd(8)}  ${h.status.padEnd(9)}  ${h.phase}  ${cost}`;
      });
    },
    listSkills: () => [], // TODO step-29
    goal: goalRuntime,
  }), [appendSystem, exit, goalRuntime]);

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
  }, [model, provider, runSlash, mode]);

  const onCancel = useCallback(() => {
    if (busy) {
      cancelledRef.current = true;
      appendSystem("已请求取消当前运行（Esc）。");
      return;
    }
    if (goalAcRef.current && goalState?.status === "active") {
      goalAcRef.current.abort();
      goalAcRef.current = null;
      appendSystem("已请求取消 /goal 循环（Esc）。");
    }
  }, [busy, appendSystem, goalState]);

  const onCtrlC = useCallback(() => {
    if (busy) {
      cancelledRef.current = true;
      appendSystem("已中断当前运行。再次按 Ctrl+C 可退出 REPL。");
      ctrlCArmedRef.current = true;
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = setTimeout(() => { ctrlCArmedRef.current = false; }, 1500);
      return;
    }
    if (ctrlCArmedRef.current) {
      // Cancel any in-flight goal before exiting so the loop's finally
      // block runs (telemetry, persist).
      goalAcRef.current?.abort();
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
    // Best-effort: cancel any pending goal so the unmount doesn't leave
    // an orphaned engine call running.
    goalAcRef.current?.abort();
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

      {showGoalPanel && goalState ? (
        <Box marginTop={1}>
          <GoalPanel
            goal={goalState}
            focused={focus === "goal"}
            onPause={() => {
              goalAcRef.current?.abort();
              const cur = goalState;
              if (cur) {
                finalizeGoal(cur.threadId, "paused");
                setGoalState({ ...cur, status: "paused" });
              }
              appendSystem("Goal paused（/goal resume 可继续）。");
            }}
            onCancel={() => {
              goalAcRef.current?.abort();
              setGoalState(null);
              appendSystem("Goal cancelled.");
            }}
          />
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

      {showSwarmPanel ? (
        <Box marginTop={1}>
          <SwarmPanel
            agents={swarm.agents}
            budget={{ spent: swarm.budget.costUSD }}
            focused={focus === "swarm"}
            onClose={() => setFocus("input")}
            onGoalToggle={() => {
              // Legacy hook from the swarm panel (predates step-23). Toggle
              // focus to the goal panel if one is active, else no-op.
              if (showGoalPanel) setFocus("goal");
            }}
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
      {focus !== "input" ? (
        <Text dimColor>{`  (panel focused: ${focus} — Tab to cycle)`}</Text>
      ) : null}
    </Box>
  );
}
