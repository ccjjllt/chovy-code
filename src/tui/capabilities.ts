import { createContext, useContext, useState, useEffect } from "react";

export interface TerminalCaps {
  cols: number;
  rows: number;
  trueColor: boolean;
  unicode: boolean;
  isConHost: boolean;
  isWindowsTerminal: boolean;
  isFullScreenCapable: boolean;
}

export function detectTerminal(): TerminalCaps {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const colorterm = process.env["COLORTERM"] ?? "";
  const trueColor = /truecolor|24bit/i.test(colorterm);
  const isWT = !!process.env["WT_SESSION"];
  const isConHost = process.platform === "win32" && !isWT && !process.env["TERM_PROGRAM"];
  const unicode = !isConHost || isWT;

  return {
    cols,
    rows,
    trueColor,
    unicode,
    isConHost,
    isWindowsTerminal: isWT,
    isFullScreenCapable: !isConHost,
  };
}

const defaultCaps = detectTerminal();
export const TerminalCapsContext = createContext<TerminalCaps>(defaultCaps);

export function useTerminalCaps(): TerminalCaps {
  return useContext(TerminalCapsContext);
}

export function useTerminalSize(): { cols: number; rows: number } {
  const [size, setSize] = useState({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  useEffect(() => {
    const onResize = () => {
      setSize((prev) => ({
        cols: process.stdout.columns ?? prev.cols,
        rows: process.stdout.rows ?? prev.rows,
      }));
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return size;
}
