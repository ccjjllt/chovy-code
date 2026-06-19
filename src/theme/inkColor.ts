const ANSI_16_COLORS = [
  { name: "black", hex: "#000000" },
  { name: "red", hex: "#800000" },
  { name: "green", hex: "#008000" },
  { name: "yellow", hex: "#808000" },
  { name: "blue", hex: "#000080" },
  { name: "magenta", hex: "#800080" },
  { name: "cyan", hex: "#008080" },
  { name: "white", hex: "#C0C0C0" },
  { name: "blackBright", hex: "#808080" },
  { name: "redBright", hex: "#FF0000" },
  { name: "greenBright", hex: "#00FF00" },
  { name: "yellowBright", hex: "#FFFF00" },
  { name: "blueBright", hex: "#0000FF" },
  { name: "magentaBright", hex: "#FF00FF" },
  { name: "cyanBright", hex: "#00FFFF" },
  { name: "whiteBright", hex: "#FFFFFF" }
];

function hexToRgb(hex: string) {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) {
    h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  }
  const n = parseInt(h, 16);
  if (isNaN(n)) return { r: 0, g: 0, b: 0 };
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255
  };
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
  return Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2);
}

function nearestAnsi16(hex: string): string {
  const target = hexToRgb(hex);
  let minDist = Infinity;
  let bestName = "white";
  for (const c of ANSI_16_COLORS) {
    const rgb = hexToRgb(c.hex);
    const dist = colorDistance(target.r, target.g, target.b, rgb.r, rgb.g, rgb.b);
    if (dist < minDist) {
      minDist = dist;
      bestName = c.name;
    }
  }
  return bestName;
}

export function inkColor(hex: string, supportTrueColor: boolean): string {
  if (!hex.startsWith("#")) return hex; // Pass through named colors (e.g., 'red', 'default')
  if (supportTrueColor) return hex;
  return nearestAnsi16(hex);
}
