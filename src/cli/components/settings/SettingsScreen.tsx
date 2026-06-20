import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { SettingsProviders } from "./SettingsProviders.js";
import { SettingsModels } from "./SettingsModels.js";

interface Props {
  initialTab: "providers" | "models";
  onClose: () => void;
}

export function SettingsScreen({ initialTab, onClose }: Props) {
  const [tab, setTab] = useState<"providers" | "models">(initialTab);

  useInput((_, key) => {
    if (key.escape) {
      onClose();
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" width="100%" height="100%">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⚙ Settings 
        </Text>
        <Text dimColor> (Esc to close, Tab to switch sections)</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box marginRight={2}>
          <Text
            bold={tab === "providers"}
            color={tab === "providers" ? "green" : "white"}
          >
            {tab === "providers" ? "▶ " : "  "}
            Service Providers
          </Text>
        </Box>
        <Box>
          <Text
            bold={tab === "models"}
            color={tab === "models" ? "green" : "white"}
          >
            {tab === "models" ? "▶ " : "  "}
            Recommended Models
          </Text>
        </Box>
      </Box>

      <Box flexGrow={1} borderStyle="single" padding={1}>
        {tab === "providers" ? (
          <SettingsProviders onTabChange={(t) => setTab(t)} />
        ) : (
          <SettingsModels onTabChange={(t) => setTab(t)} />
        )}
      </Box>
    </Box>
  );
}
