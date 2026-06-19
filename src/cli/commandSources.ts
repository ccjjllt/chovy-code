import {
  registerCommand,
  type PaletteCommand,
} from "../palette/registry.js";
import { slashCommands } from "./slashCommands.js";
import { registerBuiltinPaletteCommands } from "../palette/builtin.js";
import type { ReplCtx } from "./slashCommands.js";

// Mapping slash commands to palette commands
export function registerSlashCommandsAsPalette(): void {
  for (const [name, entry] of Object.entries(slashCommands)) {
    // If we define category/id in the entry, use it; else fallback
    const id = `slash.${name}`;
    const cmd: PaletteCommand = {
      id,
      label: () => `/${name}`,
      description: () => entry.help,
      category: (entry as any).category ?? "tools", // Fallback
      run: (ctx: ReplCtx) => entry.handler("", ctx),
      slash: { name },
      source: "slash",
      suggested: (entry as any).suggested ?? false,
      direct: true,
      enabled: (entry as any).enabled,
      hidden: (entry as any).hidden,
    };
    try {
      registerCommand(cmd);
    } catch (e) {
      // Ignore duplicates
    }
  }
}

export function registerSettingsFieldsAsPalette(): void {
  // Mock settings jump commands
  const fields = [
    "theme", "lang", "keybindings", "privacy", "permissions", "sandbox", "hooks", "statusline",
    "provider", "model", "variants", "fast", "effort", "output-style", "rate-limit"
  ];
  
  for (const f of fields) {
    try {
      registerCommand({
        id: `settings.${f}`,
        label: () => `Settings: ${f}`,
        description: () => `Jump to ${f} settings`,
        category: f.match(/provider|model|variants|fast|effort|output-style|rate-limit/) ? "model" : "settings",
        run: async (ctx: ReplCtx) => {
          if (ctx.config) {
            await ctx.config.run();
          } else {
            ctx.appendSystem(`[Settings] Jumping to ${f}...`);
          }
        },
        source: "settings",
        direct: true,
      });
    } catch {}
  }
}

export async function registerSkillCommandsAsPalette(): Promise<void> {
  // Basic mock
  try {
    registerCommand({
      id: "skills.reload",
      label: () => "Reload Skills",
      category: "skills",
      run: (ctx) => ctx.appendSystem("Skills reloaded."),
      source: "skill",
      direct: true,
    });
  } catch {}
}

export async function registerPluginCommandsAsPalette(): Promise<void> {
  try {
    registerCommand({
      id: "plugins.reload",
      label: () => "Reload Plugins",
      category: "tools",
      run: (ctx) => ctx.appendSystem("Plugins reloaded."),
      source: "plugin",
      direct: true,
    });
  } catch {}
}

export async function registerWorkflowCommandsAsPalette(): Promise<void> {
  // Empty mock
}

export async function registerMcpCommandsAsPalette(): Promise<void> {
  try {
    registerCommand({
      id: "mcp.init",
      label: () => "Init MCP",
      category: "external",
      run: (ctx) => ctx.appendSystem("MCP Init"),
      source: "mcp",
      direct: true,
    });
  } catch {}
}

export async function registerAllCommandSources(_ctx: ReplCtx): Promise<void> {
  registerBuiltinPaletteCommands();
  registerSlashCommandsAsPalette();
  registerSettingsFieldsAsPalette();
  await registerSkillCommandsAsPalette();
  await registerPluginCommandsAsPalette();
  await registerWorkflowCommandsAsPalette();
  await registerMcpCommandsAsPalette();
}
