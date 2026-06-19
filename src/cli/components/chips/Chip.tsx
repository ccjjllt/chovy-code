
import { Box, Text } from "ink";

export interface ChipProps {
  icon?: string;
  label: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  hint?: string;
}

export function Chip({ icon, label, color, dim, bold, hint }: ChipProps) {
  return (
    <Box marginRight={1}>
      {icon ? <Text color={color}>{icon} </Text> : null}
      <Text color={dim ? undefined : color} dimColor={dim} bold={bold}>{label}</Text>
      {hint ? <Text dimColor>{` ${hint}`}</Text> : null}
    </Box>
  );
}
