import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../logger/logger.js";
import { chovyCacheDir } from "../fs/home.js";

export interface OnboardingState {
  v: 1;
  firstSeenAt: number;
  firstActionAt?: number;
  paletteOpenedCount: number;
  settingsOpenedCount: number;
  buddyPettedCount: number;
  langSwitchedAt?: number;
  lastSeenVersion?: string;
  conhostWarnedAt?: number;
}

const DEFAULT_STATE: OnboardingState = {
  v: 1,
  firstSeenAt: Date.now(),
  paletteOpenedCount: 0,
  settingsOpenedCount: 0,
  buddyPettedCount: 0,
};

function getOnboardingFile(): string {
  return path.join(chovyCacheDir(), "onboarding.json");
}

let inMemoryState: OnboardingState | null = null;

export function loadOnboarding(): OnboardingState {
  if (inMemoryState) return inMemoryState;

  const file = getOnboardingFile();
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(content) as Partial<OnboardingState>;
      if (parsed.v === 1) {
        inMemoryState = { ...DEFAULT_STATE, ...parsed };
        return inMemoryState;
      }
    }
  } catch (err) {
    logger.warn(`[onboarding] failed to read ${file}: ${err}`);
  }

  inMemoryState = { ...DEFAULT_STATE };
  saveOnboarding(inMemoryState);
  return inMemoryState;
}

export function saveOnboarding(s: OnboardingState): void {
  inMemoryState = { ...s };
  const file = getOnboardingFile();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Use atomic rename to prevent corruption
    const tmpFile = file + `.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(s, null, 2), "utf8");
    fs.renameSync(tmpFile, file);
  } catch (err) {
    logger.warn(`[onboarding] failed to write ${file}: ${err}`);
  }
}

export function recordEvent(
  kind: "palette" | "settings" | "buddy" | "lang" | "firstAction" | "conhostWarned",
  currentVersion: string
): void {
  const s = loadOnboarding();
  let changed = false;

  switch (kind) {
    case "palette":
      s.paletteOpenedCount++;
      changed = true;
      break;
    case "settings":
      s.settingsOpenedCount++;
      changed = true;
      break;
    case "buddy":
      s.buddyPettedCount++;
      changed = true;
      break;
    case "lang":
      if (!s.langSwitchedAt) {
        s.langSwitchedAt = Date.now();
        changed = true;
      }
      break;
    case "firstAction":
      if (!s.firstActionAt) {
        s.firstActionAt = Date.now();
        changed = true;
      }
      break;
    case "conhostWarned":
      if (!s.conhostWarnedAt) {
        s.conhostWarnedAt = Date.now();
        changed = true;
      }
      break;
  }

  if (s.lastSeenVersion !== currentVersion) {
    s.lastSeenVersion = currentVersion;
    changed = true;
  }

  if (changed) {
    saveOnboarding(s);
  }
}
