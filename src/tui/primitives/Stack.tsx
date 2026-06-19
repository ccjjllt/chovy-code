import type { ReactNode } from "react";
import { Box, type BoxProps } from "ink";

export interface StackProps extends BoxProps {
  children?: ReactNode;
}

export function Stack({ children, ...props }: StackProps) {
  return (
    <Box flexDirection="column" {...props}>
      {children}
    </Box>
  );
}
