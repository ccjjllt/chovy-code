import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import { useTerminalCaps } from "../tui/capabilities.js";
import { SplitPane } from "../tui/primitives/SplitPane.js";
import { CompanionPlayer } from "../companion/index.js";
import { resolveGifPath } from "../companion/skin.js";
import { t } from "../i18n/index.js";
import { useDynamicTips } from "./tips.js";
import type { ProviderId } from "../types/index.js";
import type { PermissionMode } from "../config/index.js";
import * as path from "node:path";

interface Props {
  provider: ProviderId;
  model: string;
  mode: PermissionMode;
  cwd: string;
  version: string;
}

export function WelcomeScreen(props: Props): React.ReactElement {
  const theme = useTheme();
  const caps = useTerminalCaps();
  if (caps.cols < 80) return <WelcomeNarrow {...props} />;

  const noCompanion = process.env["CHOVY_NO_COMPANION"] === "1";

  return (
    <Box flexDirection="column" borderStyle={theme.borderStyle} borderColor={theme.primary}>
      <Box paddingX={1}>
        <Text color={theme.primary} bold>chovy-code v{props.version}</Text>
      </Box>
      {noCompanion ? (
        <WelcomeTipsColumn />
      ) : (
        <SplitPane
          ratio={0.4}
          left={<WelcomeMascotColumn {...props} />}
          right={<WelcomeTipsColumn />}
        />
      )}
    </Box>
  );
}

function shortCwd(cwd: string, maxLength: number): string {
  if (cwd.length <= maxLength) return cwd;
  const base = path.basename(cwd);
  const truncated = "…" + path.sep + base;
  return truncated.length > maxLength ? "…" : truncated;
}

function WelcomeMascotColumn({ provider, model, mode, cwd }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text bold>{t("welcome.greet")}</Text>
      <Box marginTop={1} marginBottom={1}>
        <CompanionPlayer gifPath={resolveGifPath("idle", "default", cwd)} active cols={18}/>
      </Box>
      <Text dimColor>{`${provider}/${model} · ${mode}`}</Text>
      <Text dimColor>{shortCwd(cwd, 40)}</Text>
    </Box>
  );
}



function WelcomeTipsColumn(): React.ReactElement {
  const theme = useTheme();
  const tips = useDynamicTips();
  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Text bold color={theme.primary}>{t("welcome.tips.title")}</Text>
      <Text> </Text>
      <Text>{t("welcome.tips.init")}</Text>
      <Text> </Text>
      <Text bold color={theme.accent}>{t("welcome.whatsnew")}</Text>
      {tips.map((tip, i) => <Text key={i}>{tip.icon} {tip.text}</Text>)}
      <Text> </Text>
      <Text dimColor>{t("welcome.releasenotes")}</Text>
    </Box>
  );
}

function WelcomeNarrow(props: Props): React.ReactElement {
  const theme = useTheme();
  const caps = useTerminalCaps();
  const noCompanion = process.env["CHOVY_NO_COMPANION"] === "1";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary}>
      <Text bold>{t("welcome.greet")}</Text>
      {!noCompanion && (
        <CompanionPlayer gifPath={resolveGifPath("idle", "default", props.cwd)} active
                         cols={Math.min(caps.cols - 4, 20)} />
      )}
      <Text dimColor>{props.model}</Text>
      <Text dimColor>{t("welcome.tips.palette")}</Text>
    </Box>
  );
}
