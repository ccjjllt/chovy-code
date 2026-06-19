import type { ReactNode } from "react";
import { Box } from "ink";
import { useTerminalSize } from "../capabilities";

export interface ConstrainProps {
  children: ReactNode;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  overflow?: "hidden" | "visible";
}

export function Constrain({
  children,
  minWidth,
  maxWidth,
  minHeight,
  maxHeight,
  overflow = "hidden",
}: ConstrainProps) {
  const { cols, rows } = useTerminalSize();

  let finalWidth: number | string = "100%";
  if (minWidth !== undefined && cols < minWidth) finalWidth = minWidth;
  else if (maxWidth !== undefined && cols > maxWidth) finalWidth = maxWidth;

  let finalHeight: number | undefined = undefined;
  if (minHeight !== undefined && rows < minHeight) finalHeight = minHeight;
  else if (maxHeight !== undefined && rows > maxHeight) finalHeight = maxHeight;

  return (
    <Box
      width={finalWidth}
      height={finalHeight}
      flexDirection="column"
      overflow={overflow}
    >
      {children}
    </Box>
  );
}
