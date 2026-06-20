import { Box, Text } from "ink";
import { useTheme } from "../../theme/index.js";

export function TodoPanel({ todos }: { todos: string[] }) {
  const theme = useTheme();

  if (!todos || todos.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>📝 Todos ({todos.length})</Text>
      <Box flexDirection="column" marginLeft={1} marginTop={1}>
        {todos.map((todo, idx) => (
          <Text key={idx} dimColor>
            {`[ ] ${todo}`}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
