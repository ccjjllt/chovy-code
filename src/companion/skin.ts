import * as path from "node:path";
import { chovyHome } from "../fs/index.js";
import type { CompanionState } from "./types.js";

const DEFAULT_SKIN: Record<CompanionState, string> = {
  idle: "gif/2026-06-12_012827.GIF",
  work: "gif/2026-06-12_012830.GIF",
  think: "gif/2026-06-12_012832.GIF",
  done: "gif/2026-06-12_012835.GIF",
  error: "gif/2026-06-12_234328.GIF",
};

export function resolveGifPath(state: CompanionState, skinName: string, cwd: string): string {
  if (skinName === "default" || skinName === "") {
    return path.resolve(cwd, DEFAULT_SKIN[state]);
  }
  // 用户自定义 skin: ~/.chovy/skins/<name>/<state>.gif
  return path.join(chovyHome(), "skins", skinName, `${state}.gif`);
}
