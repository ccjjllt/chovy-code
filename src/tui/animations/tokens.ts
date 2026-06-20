import { loadConfig } from "../../config/index.js";

export const ANIM_ENABLED = (() => {
  if (process.env["CHOVY_NO_ANIM"] === "1") return false;
  const cfg = loadConfig();
  return cfg.tui?.animations !== false; // 默认 true
})();

export const FADE_FRAMES = 6;
export const FADE_FRAME_MS = 50;
export const SLIDE_FRAMES = 5;
export const SLIDE_FRAME_MS = 32;
