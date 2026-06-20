
import { Box, Text } from "ink";
import { useTheme } from "../../theme/index.js";

export function DiffView({ toolName, args }: { toolName: string; args: any }) {
  const theme = useTheme();

  if (!args) return null;

  if (toolName === "file_edit" && args.targetContent && args.replacementContent) {
    return (
      <Box flexDirection="column" marginLeft={2} paddingLeft={1} borderLeft borderStyle="single" borderColor={theme.borderStyle}>
        <Text color={theme.error}>- {args.targetContent.slice(0, 500).replace(/\n/g, " ")}{args.targetContent.length > 500 ? "..." : ""}</Text>
        <Text color={theme.success}>+ {args.replacementContent.slice(0, 500).replace(/\n/g, " ")}{args.replacementContent.length > 500 ? "..." : ""}</Text>
      </Box>
    );
  }
  if (toolName === "file_write" && args.codeContent) {
    return (
      <Box flexDirection="column" marginLeft={2} paddingLeft={1} borderLeft borderStyle="single" borderColor={theme.borderStyle}>
        <Text color={theme.success}>+ {args.codeContent.slice(0, 500).replace(/\n/g, " ")}{args.codeContent.length > 500 ? "..." : ""}</Text>
      </Box>
    );
  }
  if (toolName === "bash" && args.command) {
    return (
      <Box flexDirection="column" marginLeft={2} paddingLeft={1} borderLeft borderStyle="single" borderColor={theme.borderStyle}>
        <Text color={theme.warning}>$ {args.command}</Text>
      </Box>
    );
  }
  return null;
}
