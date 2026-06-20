import { listThemes, setTheme, resetTheme, setCustomTheme, createTheme, getTheme } from "../../theme/index.js";
import type { SlashEntry } from "../slashCommands.js";
import { t } from "../../i18n/index.js";
import { showToast } from "../components/toastBus.js";

export const themeSlashEntry: SlashEntry = {
  help: t("slash.theme.desc"),
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0];
    
    if (!sub) {
      ctx.appendSystem("用法: /theme list | set <name> | custom k=v... | reset | create <name> k=v...");
      return;
    }

    if (sub === "list") {
      const themes = listThemes();
      const current = getTheme().name;
      const lines = ["内置主题:"];
      for (const t of themes) {
        lines.push(`  ${t.name === current ? "*" : " "} ${t.name}`);
      }
      ctx.appendSystem(lines.join("\n"));
      return;
    }

    if (sub === "set") {
      const name = parts[1];
      if (!name) {
        ctx.appendSystem("用法: /theme set <name>");
        return;
      }
      try {
        setTheme(name);
        showToast({ variant: "success", text: `主题已切换为 ${name}` });
      } catch (e: any) {
        showToast({ variant: "error", text: `切换失败: ${e.message}` });
      }
      return;
    }

    if (sub === "reset") {
      resetTheme();
      showToast({ variant: "success", text: "主题已重置为 ChovyDefault，清空自定义颜色。" });
      return;
    }

    if (sub === "custom") {
      const kvArgs = parts.slice(1);
      if (kvArgs.length === 0) {
        ctx.appendSystem("用法: /theme custom primary=#A855F7 accent=#38BDF8 ...");
        return;
      }
      const custom: Record<string, string> = {};
      for (const kv of kvArgs) {
        const idx = kv.indexOf("=");
        if (idx > 0) {
          custom[kv.slice(0, idx)] = kv.slice(idx + 1);
        }
      }
      setCustomTheme(custom);
      showToast({ variant: "success", text: "已应用自定义主题颜色。" });
      return;
    }

    if (sub === "create") {
      const name = parts[1];
      const kvArgs = parts.slice(2);
      if (!name) {
        ctx.appendSystem("用法: /theme create <name> primary=#fff ...");
        return;
      }
      const custom: Record<string, string> = {};
      for (const kv of kvArgs) {
        const idx = kv.indexOf("=");
        if (idx > 0) {
          custom[kv.slice(0, idx)] = kv.slice(idx + 1);
        }
      }
      createTheme(name, custom);
      showToast({ variant: "success", text: `新主题 ${name} 已创建并应用。` });
      return;
    }

    ctx.appendSystem(`未知的子命令: ${sub}`);
  },
};
