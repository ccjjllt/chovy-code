import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { writeFileSync } from "node:fs";
import { chovyProviders } from "../../../providers/chovyModels.js";
import { loadConfig, resetConfigCache } from "../../../config/config.js";
import { chovyConfigPath } from "../../../config/home.js";
import type { ProviderId } from "../../../types/provider.js";

interface Props {
  onTabChange: (tab: "providers" | "models") => void;
}

export function SettingsModels({ onTabChange }: Props) {
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | null>(null);
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [status, setStatus] = useState<string>("");

  const config = loadConfig();
  const providerKeys = Object.keys(chovyProviders) as ProviderId[];

  const currentProviderId = config.provider;
  const activeModelId = config.model;

  // Derive models for the selected provider
  const builtInModels = selectedProviderId ? (chovyProviders[selectedProviderId]?.models || []) : [];
  const customModelsRaw = selectedProviderId ? (config.customModels?.[selectedProviderId] || []) : [];
  const customModels = customModelsRaw.map(m => ({ id: m.id, name: m.id, lab: "Custom" }));
  const combinedModels = [...builtInModels, ...customModels];

  useInput((_, key) => {
    if (!selectedProviderId) {
      // Provider selection mode
      if (key.upArrow) {
        setProviderIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setProviderIndex((i) => Math.min(providerKeys.length - 1, i + 1));
      } else if (key.tab) {
        onTabChange("providers");
      } else if (key.return) {
        setSelectedProviderId(providerKeys[providerIndex]!);
        setModelIndex(0);
        setStatus("");
      }
    } else {
      // Model selection mode
      if (key.upArrow) {
        setModelIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setModelIndex((i) => Math.min(combinedModels.length - 1, i + 1));
      } else if (key.tab) {
        onTabChange("providers");
      } else if (key.escape || key.backspace) {
        setSelectedProviderId(null);
      } else if (key.return) {
        // Save provider and model to config
        try {
          const safeIndex = Math.min(modelIndex, Math.max(0, combinedModels.length - 1));
          const selected = combinedModels[safeIndex];
          if (!selected) return;
          writeFileSync(chovyConfigPath(), JSON.stringify({ ...config, provider: selectedProviderId, model: selected.id }, null, 2), "utf8");
          resetConfigCache();
          setStatus(`Saved: ${selected.name} (${selectedProviderId})`);
        } catch (err) {
          setStatus(`Failed to save: ${err}`);
        }
      }
    }
  });

  if (!selectedProviderId) {
    return (
      <Box flexDirection="column" width="100%">
        <Box marginBottom={1}>
          <Text bold underline>
            Select Provider to View Models
          </Text>
        </Box>
        <Box flexDirection="column" height={10} overflowY="hidden">
          {providerKeys.slice(Math.max(0, providerIndex - 4), Math.max(0, providerIndex - 4) + 10).map((k) => {
            const p = chovyProviders[k]!;
            const isSelected = k === providerKeys[providerIndex];
            const isActive = k === currentProviderId;
            return (
              <Box key={k} justifyContent="space-between" width="50%">
                <Text color={isSelected ? "green" : "white"}>
                  {isSelected ? "❯ " : "  "}
                  {p.name} {isActive ? <Text color="yellow">(Active)</Text> : ""}
                </Text>
              </Box>
            );
          })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑/↓ to navigate. Enter to select provider.</Text>
        {status && <Text color="yellow">{status}</Text>}
      </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box marginBottom={1}>
        <Text bold underline>
          Models for {chovyProviders[selectedProviderId]?.name || selectedProviderId}
        </Text>
      </Box>
      <Box flexDirection="column" height={10} overflowY="hidden">
        {combinedModels.length === 0 ? (
          <Text dimColor>  No models found.</Text>
        ) : (() => {
          const safeIndex = Math.min(modelIndex, Math.max(0, combinedModels.length - 1));
          return combinedModels.slice(Math.max(0, safeIndex - 4), Math.max(0, safeIndex - 4) + 10).map((m) => {
            const isSelected = m.id === combinedModels[safeIndex]?.id;
            const isActive = selectedProviderId === currentProviderId && m.id === activeModelId;
            return (
              <Box key={m.id} justifyContent="space-between" width="70%">
                <Text color={isSelected ? "green" : "white"}>
                  {isSelected ? "❯ " : "  "}
                  {m.name} {isActive ? <Text color="yellow">(Active)</Text> : ""}
                </Text>
                <Text dimColor>{m.lab}</Text>
              </Box>
            );
          });
        })()}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑/↓ to navigate. Enter to save model. Esc/Backspace to return to providers.</Text>
        {status && <Text color="yellow">{status}</Text>}
      </Box>
    </Box>
  );
}
