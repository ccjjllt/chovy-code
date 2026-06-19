import { Box } from 'ink';

export interface CardProps {
  children: React.ReactNode;
  padding?: number;
}

export function Card({ children, padding = 1 }: CardProps) {
  const isNoTui = process.env.CHOVY_NO_TUI === '1';
  return (
    <Box padding={isNoTui ? 0 : padding}>
      {children}
    </Box>
  );
}
