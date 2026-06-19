import type { ReactNode } from "react";
import { Box } from "ink";

export interface OverlayHostProps {
  active: boolean;
  children: ReactNode;
}

export function OverlayHost({ active, children }: OverlayHostProps) {
  const isNoTui = process.env.CHOVY_NO_TUI === '1';
  return (
    <Box
      display={active ? "flex" : "none"}
      borderStyle={isNoTui ? undefined : "double"}
      flexDirection="column"
      flexGrow={1}
      width="100%"
    >
      {children}
    </Box>
  );
}
