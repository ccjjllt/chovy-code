import { t } from "../i18n/index.js";
import { loadOnboarding, saveOnboarding } from "./onboarding.js";
import { version } from "../version.js";
import { logger } from "../logger/logger.js";

export interface Tip {
  icon: string;
  text: string;
}

export function getStaticTips(): Tip[] {
  return [
    { icon: "•", text: t("welcome.tips.palette") },
    { icon: "•", text: t("welcome.tips.settings") },
    { icon: "•", text: t("welcome.tips.lang") },
    { icon: "•", text: t("welcome.tips.buddy") },
    { icon: "•", text: t("welcome.tips.goal") },
  ];
}

import { useState, useEffect } from "react";

export function useDynamicTips(): Tip[] {
  const [tips] = useState(() => {
    let state;
    try {
      state = loadOnboarding();
    } catch (err) {
      logger.warn(`[tips] fallback to static tips: ${err}`);
      return getStaticTips();
    }

    const newTips: Tip[] = [];

    // 1. Version upgrade info
    if (state.lastSeenVersion && state.lastSeenVersion !== version) {
      newTips.push({
        icon: "✨",
        text: t("welcome.upgraded", { from: state.lastSeenVersion, to: version })
      });
    }

    // 2. Palette recommendation
    if (state.paletteOpenedCount === 0) {
      newTips.push({ icon: "•", text: t("welcome.tips.palette") });
    }

    // 3. Settings recommendation
    if (state.settingsOpenedCount === 0) {
      newTips.push({ icon: "•", text: t("welcome.tips.settings") });
    }

    // 4. Lang switch recommendation
    if (!state.langSwitchedAt) {
      newTips.push({ icon: "•", text: t("welcome.tips.lang") });
    }

    // 5. Buddy recommendation
    if (state.buddyPettedCount === 0) {
      newTips.push({ icon: "•", text: t("welcome.tips.buddy") });
    }

    // 6. Fill up with remaining recommendations if needed
    if (newTips.length < 5) {
      newTips.push({ icon: "•", text: t("welcome.tips.goal") });
    }
    if (newTips.length < 5) {
      newTips.push({ icon: "•", text: t("welcome.tips.releasenotes") });
    }

    return newTips.slice(0, 5);
  });

  useEffect(() => {
    try {
      const state = loadOnboarding();
      if (state.lastSeenVersion !== version) {
        state.lastSeenVersion = version;
        saveOnboarding(state);
      }
    } catch {}
  }, []);

  return tips;
}
