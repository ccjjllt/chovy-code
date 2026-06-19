import { Box } from 'ink';

export interface CardProps {
  children: React.ReactNode;
  padding?: number;
}

export function Card({ children, padding = 1 }: CardProps) {
  return (
    <Box padding={padding}>
      {children}
    </Box>
  );
}
