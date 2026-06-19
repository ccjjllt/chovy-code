const RANGES_FULLWIDTH: [number, number][] = [
  [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
  [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE30, 0xFE4F],
  [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
];

export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue;  // control
    let full = false;
    for (const [a, b] of RANGES_FULLWIDTH) {
      if (cp >= a && cp <= b) {
        full = true;
        break;
      }
    }
    w += full ? 2 : 1;
  }
  return w;
}

export function wrapByDisplayWidth(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;
  for (const char of text) {
    const cw = stringWidth(char);
    if (currentWidth + cw > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = char;
      currentWidth = cw;
    } else {
      currentLine += char;
      currentWidth += cw;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}
