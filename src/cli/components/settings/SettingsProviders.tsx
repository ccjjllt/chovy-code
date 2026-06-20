import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { writeFileSync } from "node:fs";
import { chovyProviders } from "../../../providers/chovyModels.js";
import { loadConfig, resetConfigCache } from "../../../config/config.js";
import { chovyConfigPath } from "../../../config/home.js";
import { setSecret, getSecret } from "../../../config/secrets.js";
import { InputBox } from "../../inputBox.js";
import type { ProviderId } from "../../../types/provider.js";

interface Props {
  onTabChange: (tab: "providers" | "models") => void;
}

interface WizardState {
  provider: ProviderId;
  step: "apikey" | "modelId" | "contextWindow";
  apiKey: string;
  modelId: string;
}

export function SettingsProviders({ onTabChange }: Props) {
  const providerKeys = Object.keys(chovyProviders) as ProviderId[];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [wizard, setWizard] = useState<WizardState | null>(null);

  useInput((_, key) => {
    if (wizard) return; // Disable navigation while in wizard
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(providerKeys.length - 1, i + 1));
    } else if (key.tab) {
      onTabChange("models");
    } else if (key.return) {
      const pId = providerKeys[selectedIndex]!;
      setWizard({ provider: pId, step: "apikey", apiKey: "", modelId: "" });
    }
  });

  if (wizard) {
    const pId = wizard.provider;
    const existingKey = getSecret(pId);

    if (wizard.step === "apikey") {
      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="green">
          <Text bold>Configure API Key for {chovyProviders[pId]?.name}</Text>
          <Text dimColor>Enter API Key (currently {existingKey ? "set" : "not set"}, press Esc to cancel):</Text>
          <InputBox
            history={[]}
            onSubmit={(text) => {
              if (text.trim()) {
                setSecret(pId, text.trim());
              }
              setWizard({ ...wizard, step: "modelId", apiKey: text.trim() });
            }}
            onCancel={() => setWizard(null)}
            onCtrlC={() => setWizard(null)}
          />
        </Box>
      );
    }

    if (wizard.step === "modelId") {
      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="green">
          <Text bold>Add Custom Model for {chovyProviders[pId]?.name}</Text>
          <Text dimColor>Enter Model ID (e.g. deepseek-chat). Leave blank to finish config:</Text>
          <InputBox
            history={[]}
            onSubmit={(text) => {
              if (!text.trim()) {
                setWizard(null); // Finished
              } else {
                setWizard({ ...wizard, step: "contextWindow", modelId: text.trim() });
              }
            }}
            onCancel={() => setWizard(null)}
            onCtrlC={() => setWizard(null)}
          />
        </Box>
      );
    }

    if (wizard.step === "contextWindow") {
      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="green">
          <Text bold>Context Window for {wizard.modelId}</Text>
          <Text dimColor>Enter Context Window size (e.g. 128000). Leave blank for default:</Text>
          <InputBox
            history={[]}
            onSubmit={(text) => {
              const config = loadConfig();
              const cw = parseInt(text.trim(), 10);
              const newModel = { 
                id: wizard.modelId, 
                ...(isNaN(cw) ? {} : { contextWindow: cw }) 
              };
              
              const customModels = { ...config.customModels };
              if (!customModels[pId]) customModels[pId] = [];
              // Prevent duplicates, replace if exists
              customModels[pId] = customModels[pId]!.filter(m => m.id !== wizard.modelId);
              customModels[pId]!.push(newModel);

              writeFileSync(
                chovyConfigPath(), 
                JSON.stringify({ ...config, customModels }, null, 2), 
                "utf8"
              );
              resetConfigCache();
              setWizard(null);
            }}
            onCancel={() => setWizard(null)}
            onCtrlC={() => setWizard(null)}
          />
        </Box>
      );
    }
  }

  const currentProviderId = loadConfig().provider;

  return (
    <Box flexDirection="column" width="100%">
      <Box marginBottom={1}>
        <Text bold underline>
          Connected Providers / Other Custom Providers
        </Text>
      </Box>
      <Box flexDirection="column" height={12} overflowY="hidden">
        {providerKeys.slice(Math.max(0, selectedIndex - 5), Math.max(0, selectedIndex - 5) + 12).map((k) => {
          const p = chovyProviders[k]!;
          const isSelected = k === providerKeys[selectedIndex];
          const isActive = k === currentProviderId;
          const hasKey = !!getSecret(k);
          return (
            <Box key={k} justifyContent="space-between" width="50%">
              <Text color={isSelected ? "green" : "white"}>
                {isSelected ? "❯ " : "  "}
                {p.name} {isActive ? <Text color="yellow">(Active)</Text> : ""}
              </Text>
              <Text color={hasKey ? "green" : "red"}>{hasKey ? "✓" : "✗"}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ to navigate. Enter to configure provider (API Key & Models).</Text>
      </Box>
    </Box>
  );
}
