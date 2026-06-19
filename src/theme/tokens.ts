export interface Theme {
  name: string;
  primary: string;
  accent: string;
  bg: string;
  fg: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  borderStyle: "round" | "single" | "double" | "bold";
  spinnerFrames: string[];
}

export const ChovyDefault: Theme = {
  name: "ChovyDefault",
  primary: "#7C3AED",
  accent: "#3B82F6",
  bg: "default",
  fg: "#E5E7EB",
  muted: "#6B7280",
  success: "#10B981",
  warning: "#F59E0B",
  error: "#EF4444",
  borderStyle: "round",
  spinnerFrames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"],
};

export const ChovyLight: Theme = {
  ...ChovyDefault,
  name: "ChovyLight",
  primary: "#6D28D9",
  accent: "#2563EB",
  bg: "#FFFFFF",
  fg: "#1F2937",
  muted: "#9CA3AF",
  borderStyle: "single",
};

export const ChovyHighContrast: Theme = {
  ...ChovyDefault,
  name: "ChovyHighContrast",
  primary: "#FFFFFF",
  accent: "#00FFFF",
  bg: "#000000",
  fg: "#FFFFFF",
  muted: "#AAAAAA",
  borderStyle: "bold",
};

export const ChovySolarized: Theme = {
  ...ChovyDefault,
  name: "ChovySolarized",
  primary: "#268BD2",
  accent: "#D33682",
  bg: "#002B36",
  fg: "#839496",
  muted: "#586E75",
  success: "#859900",
  warning: "#B58900",
  error: "#DC322F",
};

export const ChovyMonochrome: Theme = {
  ...ChovyDefault,
  name: "ChovyMonochrome",
  primary: "white",
  accent: "white",
  bg: "black",
  fg: "white",
  muted: "gray",
  success: "white",
  warning: "white",
  error: "white",
};

export const BUILT_INS: Theme[] = [ChovyDefault, ChovyLight, ChovyHighContrast, ChovySolarized, ChovyMonochrome];
