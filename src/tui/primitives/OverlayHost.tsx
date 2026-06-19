import type { ReactNode } from "react";
import { Box } from "ink";

export interface OverlayHostProps {
  active: boolean;
  children: ReactNode;
}

export function OverlayHost({ active, children }: OverlayHostProps) {
  return (
    <Box
      display={active ? "flex" : "none"}
      borderStyle="double"
      flexDirection="column"
      flexGrow={1}
      width="100%"
    >
      {children}
    </Box>
  );
}
