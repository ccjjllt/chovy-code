import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { runAgent } from "../agent/index.js";
import { getSubAgentPool } from "../agent/index.js";
import { listProviders } from "../providers/index.js";
import { logger } from "../logger/index.js";
import type { ProviderId } from "../types/index.js";
import type { PermissionMode } from "../config/index.js";
import { HeaderBar, type BudgetSnapshot, type SwarmSummary, type GoalChipSnapshot } from "./components/HeaderBar.js";
import { MessageList, type UIMessage } from "./components/MessageList.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { StatusLine } from "./components/StatusLine.js";
import { SwarmPanel } from "./components/SwarmPanel.js";
import { GoalPanel } from "./components/GoalPanel.js";
import { InputBox } from "./inputBox.js";
import { useTerminalCaps } from "../tui/capabilities.js";
import { mountCompanion, CompanionHost, companionReservedColumns, type CompanionHandle } from "../companion/index.js";
import { useSwarmState, swarmCounts } from "./state/swarmStore.js";
import {
  slashCommands,
  listSlashEntries,
  type ReplCtx,
  type ReplGoalRuntime,
  type ReplCheckpointRuntime,
  type ReplSkillRuntime,
  type ReplSkillListItem,
  type ReplSkillPlanDryRun,
  type ReplConfigRuntime,
  type ReplMemRuntime,
  type ReplMemListItem,
} from "./slashCommands.js";
import { runConfigWizard } from "./configWizard.js";
import {
  createGoal,
  finalizeGoal,
  listGoals,
  runGoal,
  type CreateGoalInput,
  type RunGoalResult,
} from "../goals/index.js";
import { getCheckpointCoordinator } from "../memory/index.js";
import {
  createMemoryStore,
  syncProject,
} from "../memory/index.js";
import type { MemoryLayer, MemoryType } from "../types/index.js";
import { MEMORY_LAYERS, MEMORY_TYPES } from "../types/index.js";
import { checkpointDir } from "../fs/paths.js";
import { safeFs } from "../fs/safeFs.js";
import { getCapability } from "../providers/capabilities.js";
import {
  ensureBundledSkillsInitialized,
  extractIntent,
  getSkill,
  listSkills as listAllSkills,
  plan as planSkills,
  resolveManualClosure,
} from "../skills/index.js";
import { computeBudget } from "../context/budgets.js";
import { loadConfig } from "../config/config.js";
import type { GoalState, ToolSession } from "../types/index.js";
import { getCompanionStateMachine } from "../companion/index.js";
import { useKeybinding } from "../keybindings/index.js";
import { CommandPalette } from "../palette/index.js";
import { usePaletteState, openPalette } from "../palette/state.js";
import { registerAllCommandSources } from "./commandSources.js";
import { version } from "../version.js";
import { WelcomeScreen } from "../screens/welcome.js";

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
  const sm = getCompanionStateMachine();
  const caps = useTerminalCaps();
  const companionRef = useRef<CompanionHandle>();
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    companionRef.current = mountCompanion({ cwd: process.cwd(), muted: false });
    const unsubscribe = sm.onChange((s) => {
      if (s === "done" || s === "error") setSpeaking(true);
      else if (s === "idle" || s === "work") setSpeaking(false);
    });
    return () => {
      unsubscribe();
      companionRef.current?.dispose();
    };
  }, [sm]);

  const { open: paletteOpen } = usePaletteState();

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
  // step-16/27: budget snapshot wired live by `runAgent`'s onUsage +
  // onContextSnapshot callbacks. The HeaderBar reads these for the
  // `ctx NN%` / `$X.XXXX` chip.
  const [budget, setBudget] = useState<BudgetSnapshot>({
    costUSD: 0,
    ctxUsedTokens: 0,
    ctxTotalTokens: 0,
  });

  const welcomeDismissedRef = useRef(false);
  const showWelcome = !welcomeDismissedRef.current
    && messages.length <= 1 && messages[0]?.role === "system";

  useEffect(() => {
    if (messages.length > 1) welcomeDismissedRef.current = true;
  }, [messages.length]);

  const cancelledRef = useRef(false);
  const ctrlCArmedRef = useRef(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastToolTimeRef = useRef(0);

  // step-29: stable per-REPL ToolSession. Plumbed into `runAgent({ session })`
  // every turn so manual skill activations (`/skill <name>` and SkillTool)
  // and todos persist across turns. Engine mutates the same reference in
  // place; the slash skill runtime mutates it as well.
  const sessionRef = useRef<ToolSession>({ todoList: [], activeSkillFragments: {}, manualSkillNames: [] });

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

  const goalSummary: GoalChipSnapshot | undefined = goalState
    ? {
        rounds: goalState.rounds,
        status: goalState.status as "active" | "paused",
        budgetUsed: goalState.totalCostUSD,
        budgetCap: goalState.budgetUSD,
      }
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

  useKeybinding("buddy.pet", () => {
    companionRef.current?.pet();
  }, { isActive: !busy });

  useKeybinding("palette.open", () => openPalette(), { isActive: !busy });

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

  // ── step-26: REPL checkpoint runtime injected into ReplCtx.checkpoint ────
  const checkpointRuntime: ReplCheckpointRuntime = useMemo(() => ({
    triggerNow: async (): Promise<string> => {
      // Snapshot the live message tail (bounded — coordinator caps further).
      const recentMessages = messages.slice(-12).map((m) => ({
        role: (m.role === "system" ? "user" : m.role) as
          | "user"
          | "assistant"
          | "tool",
        content: m.content,
      }));
      const result = await getCheckpointCoordinator().maybeCheckpoint(
        "manual",
        {
          cwd: process.cwd(),
          objective: goalState?.objective,
          recentMessages,
          historyTail: goalState ? goalState.history.slice(-5) : [],
          provider,
          model,
          threadId: threadIdRef.current,
        },
      );
      if (result.reason === "debounced") {
        return "debounced (already checkpointed within last 30s)";
      }
      if (!result.ok) {
        return `failed: ${result.error ?? "unknown"}`;
      }
      const tag = result.mode === "fallback" ? "fallback" : "ok";
      return `${tag} (${result.bytes}B → ${result.latestPath})`;
    },
    list: async (): Promise<{ name: string; bytes: number; ts: string }[]> => {
      const dir = checkpointDir(process.cwd());
      let entries: string[];
      try {
        entries = await safeFs.list(dir, { recursive: false });
      } catch {
        return [];
      }
      const out: { name: string; bytes: number; ts: string }[] = [];
      for (const entry of entries) {
        const full = entry.startsWith(dir) ? entry : `${dir}/${entry}`;
        if (!full.endsWith(".md")) continue;
        const st = await safeFs.stat(full);
        if (!st) continue;
        const base = full.slice(dir.length + 1);
        out.push({
          name: base,
          bytes: st.size,
          ts: new Date(st.mtime).toISOString(),
        });
      }
      out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      return out;
    },
  }), [messages, goalState, provider, model]);

  // ── step-29: REPL skill runtime injected into ReplCtx.skill ──────────────
  const skillRuntime: ReplSkillRuntime = useMemo(() => ({
    list: async (): Promise<ReplSkillListItem[]> => {
      await ensureBundledSkillsInitialized();
      const all = listAllSkills();
      const active = sessionRef.current.activeSkillFragments ?? {};
      const manual = new Set(sessionRef.current.manualSkillNames ?? []);
      return all.map((s) => ({
        name: s.name,
        summary: s.summary,
        requires: s.requires ?? [],
        provides: s.provides ?? [],
        conflicts: s.conflicts ?? [],
        budgetTokens: s.budgetTokens,
        active: Object.prototype.hasOwnProperty.call(active, s.name),
        manual: manual.has(s.name),
      }));
    },
    show: async (name: string): Promise<string | null> => {
      await ensureBundledSkillsInitialized();
      const s = getSkill(name);
      return s ? s.systemFragment : null;
    },
    plan: async (): Promise<ReplSkillPlanDryRun> => {
      await ensureBundledSkillsInitialized();
      const cfg = loadConfig();
      const budget = computeBudget(model, provider, cfg, process.env);
      // Pull the latest user message from the live UI list (UIMessage uses
      // the same `role` literals as ChatMessage; `system` is REPL-only).
      const msgs = messages.filter((m) => m.role !== "system");
      let latestUserText = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "user" && msgs[i]?.content) {
          latestUserText = msgs[i]!.content;
          break;
        }
      }
      const intent = extractIntent({
        latestUserText,
        recentMessages: msgs.slice(-8).map((m) => ({
          role: m.role as "user" | "assistant" | "tool",
          content: m.content,
        })),
        goalObjective: goalState?.objective,
      });
      const result = planSkills(listAllSkills(), {
        latestUserText,
        goalObjective: goalState?.objective,
        manualNames: sessionRef.current.manualSkillNames ?? [],
        budgetTokens: budget.skills,
        recentMessages: msgs.slice(-8).map((m) => ({
          role: m.role as "user" | "assistant" | "tool",
          content: m.content,
        })),
      });
      return {
        selected: result.nodes.map((n) => n.skill.name),
        droppedByBudget: result.droppedByBudget,
        droppedByConflict: result.droppedByConflict,
        missingRequired: result.missingRequired,
        totalTokens: result.totalTokens,
        budgetTokens: budget.skills,
        tags: intent.tags.slice(0, 24),
      };
    },
    activate: async (name: string, args?: string): Promise<string> => {
      await ensureBundledSkillsInitialized();
      const target = getSkill(name);
      if (!target) {
        const known = listAllSkills().map((s) => s.name).sort().join(", ");
        return `unknown skill: ${name}. Known: ${known || "(none)"}`;
      }
      const registryMap = new Map(listAllSkills().map((s) => [s.name, s]));
      const existing = new Set(Object.keys(sessionRef.current.activeSkillFragments ?? {}));
      const closure = resolveManualClosure(target, registryMap, existing);
      if (closure.missingRequired.length > 0) {
        return `${name} needs missing skill(s): ${closure.missingRequired.join(", ")}`;
      }
      if (closure.conflictsWithActive.length > 0) {
        return `${name} conflicts with active: ${closure.conflictsWithActive.join(", ")}`;
      }
      sessionRef.current.activeSkillFragments ??= {};
      sessionRef.current.manualSkillNames ??= [];
      const argsSuffix = args && args.trim().length > 0
        ? `\n\n### Additional args\n${args.trim()}`
        : "";
      const activated: string[] = [];
      for (const node of closure.nodes) {
        sessionRef.current.activeSkillFragments[node.skill.name] = node.skill.systemFragment + argsSuffix;
        activated.push(node.skill.name);
      }
      if (!sessionRef.current.manualSkillNames.includes(target.name)) {
        sessionRef.current.manualSkillNames.push(target.name);
      }
      return activated.length === 1
        ? `activated '${target.name}'`
        : `activated '${target.name}' (chain: ${activated.join(", ")})`;
    },
    clear: async (): Promise<void> => {
      sessionRef.current.activeSkillFragments = {};
      sessionRef.current.manualSkillNames = [];
    },
  }), [messages, goalState, model, provider]);

  const configRuntime: ReplConfigRuntime = useMemo(() => ({
    run: async (): Promise<void> => {
      await runConfigWizard();
    },
  }), []);

  // ── step-24/25: REPL memory runtime injected into ReplCtx.mem ─────────────
  // Each call opens a fresh, file-synced MemoryStore (cwd-bound) and closes it
  // after formatting — mirrors the `chovy mem ...` CLI path. Output formatting
  // matches the CLI verbatim so REPL and headless read identically.
  const memRuntime: ReplMemRuntime = useMemo(() => ({
    list: async (opts): Promise<ReplMemListItem[]> => {
      const store = await createMemoryStore({ cwd: process.cwd() });
      try {
        await syncProject(process.cwd(), store);
        const filter: {
          layer?: MemoryLayer;
          type?: MemoryType;
          limit?: number;
          projectId: string;
        } = { projectId: store.projectId };
        if (opts.layer && (MEMORY_LAYERS as readonly string[]).includes(opts.layer)) {
          filter.layer = opts.layer as MemoryLayer;
        }
        if (opts.type && (MEMORY_TYPES as readonly string[]).includes(opts.type)) {
          filter.type = opts.type as MemoryType;
        }
        filter.limit = opts.limit ?? 20;
        const rows = await store.list(filter);
        return rows.map((r) => {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(",")}]` : "";
          const head = r.content.replace(/\s+/g, " ").slice(0, 120);
          return {
            line: `${r.id}  ${r.layer.padEnd(10)} ${r.type.padEnd(10)} imp=${String(r.importance).padStart(3)}  ${head}${tags}`,
          };
        });
      } finally {
        store.close();
      }
    },
    show: async (id) => {
      const store = await createMemoryStore({ cwd: process.cwd() });
      try {
        const rows = await store.list({ projectId: store.projectId, limit: 10_000 });
        const found = rows.find((r) => r.id === id);
        if (!found) return { found: false };
        const block = [
          `layer      ${found.layer}`,
          `type       ${found.type}`,
          `importance ${found.importance}`,
          `source     ${found.sourcePath}${found.sourceLine ? `:${found.sourceLine}` : ""}`,
          `tags       ${found.tags.join(", ")}`,
          `updated    ${new Date(found.updatedAt).toISOString()}`,
          "---",
          found.content,
        ].join("\n");
        return { found: true, block };
      } finally {
        store.close();
      }
    },
    search: async (query, opts) => {
      const store = await createMemoryStore({ cwd: process.cwd() });
      try {
        await syncProject(process.cwd(), store);
        const memQuery: import("../types/index.js").MemoryQuery = {
          text: query,
          ranker: opts.bm25 ? "bm25" : "mixed",
          limit: opts.limit ?? 10,
        };
        if (opts.layer && (MEMORY_LAYERS as readonly string[]).includes(opts.layer)) {
          memQuery.layers = [opts.layer as MemoryLayer];
        }
        const rows = await store.search(memQuery);
        return rows.map((r) => {
          const head = r.content.replace(/\s+/g, " ").slice(0, 140);
          const score = r.score !== undefined ? `score=${r.score.toFixed(3)} ` : "";
          return { line: `${score}${r.id}  ${r.layer}/${r.type} imp=${r.importance}  ${head}` };
        });
      } finally {
        store.close();
      }
    },
    stats: async () => {
      const store = await createMemoryStore({ cwd: process.cwd() });
      try {
        const c = await store.count({ projectId: store.projectId });
        const block = [
          `records   ${c}`,
          `path      ${store.path}`,
          `projectId ${store.projectId}`,
          `degraded  ${store.degraded ? "true (bun:sqlite missing)" : "false"}`,
        ].join("\n");
        return { block };
      } finally {
        store.close();
      }
    },
  }), []);

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
    listSkills: () => {
      const active = sessionRef.current.activeSkillFragments ?? {};
      const manual = new Set(sessionRef.current.manualSkillNames ?? []);
      const names = Object.keys(active);
      if (names.length === 0) return [];
      return names.map((n) => `  ${n}${manual.has(n) ? " [MANUAL]" : ""}`);
    },
    goal: goalRuntime,
    checkpoint: checkpointRuntime,
    skill: skillRuntime,
    config: configRuntime,
    mem: memRuntime,
  }), [appendSystem, exit, goalRuntime, checkpointRuntime, skillRuntime, configRuntime, memRuntime]);


  useEffect(() => {
    registerAllCommandSources(ctx).catch(err => {
      logger.error(`Failed to register command sources: ${err}`);
    });
  }, [ctx]);

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
    lastToolTimeRef.current = Date.now();
    sm.setState("work", "send-start");

    try {
      let buf = "";
      // step-27: PCM-priced marginal-cost helper. Avoids re-importing the
      // CostTracker just for the header chip — the real ledger lives
      // inside the engine; this is cheap UI feedback only.
      const pricing = getCapability(provider).pricing;
      const final = await runAgent(t, {
        provider,
        model,
        permissionMode: mode,
        session: sessionRef.current,
        goalObjective: goalState?.objective,
        onToken: (delta) => {
          if (cancelledRef.current) return;
          buf += delta;
          setMessages((xs) =>
            xs.map((m) => (m.id === assistantId ? { ...m, content: buf } : m)),
          );
          if (sm.current() === "work" && Date.now() - lastToolTimeRef.current > 5000) {
            sm.setState("think", "stream-only");
          }
        },
        onToolCall: (name) => {
          if (cancelledRef.current) return;
          setTool(name);
          lastToolTimeRef.current = Date.now();
          sm.setState("work", `tool=${name}`);
        },
        onContextSnapshot: (snap) => {
          // Push live ctx % + pressure color into the HeaderBar.
          setBudget((b) => ({
            ...b,
            ctxUsedTokens: snap.total,
            ctxTotalTokens: snap.thresholds.ctxWindow,
            pressureLevel: snap.level,
          }));
        },
        onUsage: (usage) => {
          // Marginal USD from this round; cumulative since REPL start.
          const inUSD = (usage.in / 1_000_000) * pricing.in;
          const outUSD = (usage.out / 1_000_000) * pricing.out;
          const marginal = inUSD + outUSD;
          if (marginal > 0) {
            setBudget((b) => ({ ...b, costUSD: b.costUSD + marginal }));
          }
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
      sm.setState("done", "send-finally");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(msg);
      setMessages((xs) => xs.map((m) =>
        m.id === assistantId ? { ...m, pending: false, content: `Error: ${msg}` } : m,
      ));
      sm.setState("error", msg);
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
      {paletteOpen ? <CommandPalette ctx={ctx} /> : null}

      <Box flexDirection="column" display={paletteOpen ? "none" : "flex"}>
        <HeaderBar
          mode={mode}
          provider={provider}
          model={model}
          budget={budget}
          swarm={swarmSummary}
          goal={goalSummary}
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

        {showWelcome ? (
          <Box marginTop={1} marginBottom={1}>
            <WelcomeScreen
              provider={provider}
              model={model}
              mode={mode}
              cwd={process.cwd()}
              version={version}
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

        <Box marginTop={1} flexDirection="row" alignItems="flex-end">
          <Box flexGrow={1} flexDirection="column" width={caps.cols - companionReservedColumns(caps.cols, speaking)}>
            <InputBox
              disabled={busy}
              history={history}
              onSubmit={send}
              onCancel={onCancel}
              onCtrlC={onCtrlC}
          />
        </Box>
        <CompanionHost cwd={process.cwd()} reservedCols={companionReservedColumns(caps.cols, speaking)} />
      </Box>
      {focus !== "input" ? (
        <Text dimColor>{`  (panel focused: ${focus} — Tab to cycle)`}</Text>
      ) : null}
      </Box>
    </Box>
  );
}
