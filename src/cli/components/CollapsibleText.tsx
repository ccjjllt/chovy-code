import React, { useState } from "react";
import { Box, Text } from "ink";
import { t } from "../../i18n/index.js";
import { loadConfig } from "../../config/index.js";

const FOLD_THRESHOLD = 3000;

export function CollapsibleText({ text }: { text: string }): React.ReactElement {
  const [open] = useState(text.length <= FOLD_THRESHOLD);
  if (open) return <Text>{text}</Text>;
  const head = text.slice(0, 800);
  return (
    <Box flexDirection="column">
      <Text>{head}</Text>
      <Text dimColor>{t("msg.fold.more", { n: text.length - 800 })}</Text>
    </Box>
  );
}

export function ReasoningBlock({ text }: { text: string }): React.ReactElement {
  const show = loadConfig().general?.showReasoningSummaries ?? true;
  const [open] = useState(show);
  return (
    <Box flexDirection="column">
      <Text dimColor>{open ? "▼ " : "▶ "}{t("msg.reasoning.summary")}</Text>
      {open ? <Text dimColor>{text}</Text> : null}
    </Box>
  );
}
