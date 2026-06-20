import React, { useEffect } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../theme/index.js";
import { type ToastEvent, useToasts, dismissToast } from "./toastBus.js";

const MAX_VISIBLE = 3;

export function ToastHost(): React.ReactElement | null {
  const items = useToasts();
  const visible = items.slice(-MAX_VISIBLE);

  useEffect(() => {
    const timers = visible.map(it => {
      const dur = it.durationMs ?? (it.variant === "error" ? 8000 : 4000);
      return setTimeout(() => dismissToast(it.id), Math.max(0, dur - (Date.now() - it.createdAt)));
    });
    return () => timers.forEach(clearTimeout);
  }, [visible]);

  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column">
      {visible.map(t => <Toast key={t.id} item={t} />)}
    </Box>
  );
}

function Toast({ item }: { item: ToastEvent }) {
  const theme = useTheme();
  
  const colors: Record<ToastEvent["variant"], string> = {
    info: theme.accent,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
  };
  
  const icons: Record<ToastEvent["variant"], string> = {
    info: "ℹ",
    success: "✓",
    warning: "⚠",
    error: "✗",
  };

  return (
    <Box borderStyle="round" borderColor={colors[item.variant]} paddingX={1}>
      <Text color={colors[item.variant]}>{icons[item.variant]}</Text>
      <Text> {item.text}</Text>
    </Box>
  );
}
