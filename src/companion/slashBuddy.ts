import type { SlashHandler, ReplCtx } from "../cli/slashCommands.js";
import { getPrefs, setMuted, setVisible, setSize, setSkin, incPetCount } from "./prefs.js";
import { t } from "../i18n/index.js";
import { companionBus } from "./stateBus.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { chovyHome } from "../fs/index.js";

export const buddyHandler: SlashHandler = async (args, ctx) => {
  const sub = args.split(/\s+/)[0] ?? "";
  if (!sub) {
    ctx.appendSystem(t("companion.slash.help") || "Usage: /buddy <pet|show|hide|mute|unmute|size|skin|stats>");
    return;
  }

  if (sub === "pet") return doPet(ctx);
  if (sub === "show") return doVisible(ctx, true);
  if (sub === "hide") return doVisible(ctx, false);
  if (sub === "mute") return doMute(ctx, true);
  if (sub === "unmute") return doMute(ctx, false);
  if (sub === "size") return doSize(args.slice("size".length).trim(), ctx);
  if (sub === "skin") return doSkin(args.slice("skin".length).trim(), ctx);
  if (sub === "stats") return doStats(ctx);

  ctx.appendSystem(`未知子命令：${sub}`);
};

function doPet(ctx: ReplCtx) {
  companionBus.emit({ type: "pet" });
  const count = incPetCount();
  if (count > 500) {
    ctx.appendSystem(t("companion.quip.over500") || "Wow, over 500 pets! You must really like this buddy.");
  } else if (count > 100) {
    ctx.appendSystem(t("companion.quip.over100") || "我快被摸秃了…");
  }
}

function doVisible(ctx: ReplCtx, visible: boolean) {
  setVisible(visible);
  ctx.appendSystem(visible ? "吉祥物已显示。" : "吉祥物已隐藏。");
}

function doMute(ctx: ReplCtx, muted: boolean) {
  setMuted(muted);
  ctx.appendSystem(muted ? "吉祥物已静音。" : "吉祥物已取消静音。");
}

function doSize(sizeStr: string, ctx: ReplCtx) {
  if (!sizeStr) {
    const s = getPrefs().size;
    ctx.appendSystem(`当前尺寸策略为: ${s}`);
    return;
  }
  if (sizeStr === "auto" || sizeStr === "compact" || sizeStr === "small") {
    setSize(sizeStr);
    ctx.appendSystem(`已将尺寸策略切换为: ${sizeStr}`);
  } else {
    ctx.appendSystem(`无效尺寸: ${sizeStr}. 允许的值: auto, compact, small`);
  }
}

function doSkin(skinStr: string, ctx: ReplCtx) {
  if (!skinStr) {
    const current = getPrefs().skin;
    ctx.appendSystem(`当前皮肤: ${current}`);
    return;
  }
  
  if (skinStr === "reset" || skinStr === "default") {
    setSkin("default");
    ctx.appendSystem("已重置为默认皮肤。");
    return;
  }

  const skinDir = path.join(chovyHome(), "skins", skinStr);
  if (!fs.existsSync(skinDir)) {
    ctx.appendSystem(`错误: 找不到皮肤文件夹 ${skinDir}`);
    return;
  }

  const required = ["idle.gif", "work.gif", "think.gif", "done.gif", "error.gif"];
  for (const req of required) {
    if (!fs.existsSync(path.join(skinDir, req))) {
      ctx.appendSystem(`错误: 皮肤文件夹缺少必需文件 ${req}`);
      return;
    }
  }

  setSkin(skinStr);
  ctx.appendSystem(`已切换到皮肤: ${skinStr}`);
}

function doStats(ctx: ReplCtx) {
  const count = getPrefs().petCount;
  ctx.appendSystem(`你已经摸过吉祥物 ${count} 次了 :)`);
}
