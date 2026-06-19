import { t, getLocale } from "../i18n/index.js";
import { bumpMru } from "./recent.js";
import { emitTelemetry } from "../telemetry/index.js";
import { logger } from "../logger/logger.js";
import { ChovyError } from "../types/errors.js";
import type { ReplCtx } from "../cli/slashCommands.js";

export type PaletteCategory =
  | "recommend" | "session" | "agent" | "model" | "provider" | "settings"
  | "prompt" | "message" | "goal" | "memory" | "skills"
  | "companion" | "diagnostics" | "tools" | "external";

export interface PaletteCommand {
  id: string;                     // Unique, e.g. "session.switch"
  label: () => string;            // i18n label function
  description?: () => string;
  category: PaletteCategory;
  hotkey?: string;                // keybinding id
  run: (ctx: ReplCtx) => Promise<void> | void;
  enabled?: boolean | ((ctx: ReplCtx) => boolean);
  hidden?: boolean | ((ctx: ReplCtx) => boolean);
  suggested?: boolean | ((ctx: ReplCtx) => boolean);
  direct?: boolean;               // true if runs immediately, false if opens UI/prefill
  slash?: { name: string; aliases?: string[]; argsHint?: string };
  source?: "builtin" | "slash" | "settings" | "skill" | "plugin" | "workflow" | "mcp";
  keywords?: string[];            // Keywords for search
}

export interface SlashSuggestion {
  display: string;
  commandId: string;
  description: string;
}

const store = new Map<string, PaletteCommand>();

export function registerCommand(c: PaletteCommand): void {
  if (store.has(c.id)) {
    throw new ChovyError("INTERNAL", `duplicate palette command: ${c.id}`);
  }
  store.set(c.id, c);
}

export function listCommands(ctx: ReplCtx): PaletteCommand[] {
  return [...store.values()].filter((c) => {
    const hidden = typeof c.hidden === "function" ? c.hidden(ctx) : !!c.hidden;
    return !hidden;
  });
}

export function listAllCommands(): PaletteCommand[] {
  return [...store.values()];
}

function commandEnabled(c: PaletteCommand, ctx: ReplCtx): boolean {
  return typeof c.enabled === "function" ? c.enabled(ctx) : c.enabled !== false;
}

export function listSlashes(ctx: ReplCtx): SlashSuggestion[] {
  return listCommands(ctx).flatMap((c) => {
    if (!commandEnabled(c, ctx)) return [];
    if (!c.slash) return [];
    const desc = c.description?.() ?? c.label();
    return [
      { display: "/" + c.slash.name, commandId: c.id, description: desc },
      ...(c.slash.aliases ?? []).map((a) => ({ display: "/" + a, commandId: c.id, description: desc })),
    ];
  });
}

export async function execCommand(item: PaletteCommand, ctx: ReplCtx): Promise<void> {
  // closePalette(); is a UI concern handled by the component. 
  bumpMru(item.id);
  emitTelemetry({ type: "tui.palette.exec", id: item.id, source: item.source ?? "builtin", locale: getLocale() } as any);
  
  if (item.enabled !== undefined && !commandEnabled(item, ctx)) {
    return ctx.appendSystem(t("palette.command.disabled"));
  }
  
  try { 
    await item.run(ctx); 
  } catch (err: any) {
    logger.warn(`palette ${item.id} failed: ${err}`);
    ctx.appendSystem(t("toast.cmdFailed", { name: item.id, msg: err instanceof Error ? err.message : String(err) }));
  }
}

export function clearRegistryForTesting(): void {
  store.clear();
}
