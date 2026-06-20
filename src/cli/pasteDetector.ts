const PASTE_THRESHOLD_MS = 5;       // 间隔 < 5ms 的连续输入视作 paste
const PASTE_MIN_CHARS = 64;
let lastInputAt = 0;
let pasteBuf = "";

export function feedKey(ch: string, now: number): { isPaste: boolean; flushed?: string } {
  if (now - lastInputAt < PASTE_THRESHOLD_MS) {
    pasteBuf += ch;
    lastInputAt = now;
    return { isPaste: true };
  }
  // gap 后 flush
  let flushed: string | undefined;
  if (pasteBuf.length >= PASTE_MIN_CHARS) {
    flushed = pasteBuf;
  }
  pasteBuf = ch;
  lastInputAt = now;
  return { isPaste: false, flushed };
}

export function resetPasteDetector() {
  lastInputAt = 0;
  pasteBuf = "";
}
