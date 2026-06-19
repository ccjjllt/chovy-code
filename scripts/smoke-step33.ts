import { detectTerminal } from "../src/tui/capabilities";
import { stringWidth } from "../src/tui/stringWidth";

console.log("--- Smoke Test Step 33 ---");

const w1 = stringWidth("你好abc");
console.log(`stringWidth("你好abc") = ${w1} (expected 7)`);
if (w1 !== 7) throw new Error("stringWidth error");

const w2 = stringWidth("aaa");
console.log(`stringWidth("aaa") = ${w2} (expected 3)`);
if (w2 !== 3) throw new Error("stringWidth error");

const originalEnv = process.env;
const originalPlatform = process.platform;

try {
  process.env = { ...originalEnv, COLORTERM: "truecolor", TERM_PROGRAM: "", WT_SESSION: "" };
  Object.defineProperty(process, "platform", { value: "win32" });

  const caps = detectTerminal();
  console.log("detectTerminal with mock (win32, no WT, truecolor env):");
  console.log(`  trueColor: ${caps.trueColor}`);
  console.log(`  isConHost: ${caps.isConHost}`);
  
  if (!caps.trueColor) throw new Error("trueColor should be true");
  if (!caps.isConHost) throw new Error("isConHost should be true on win32 without WT/TERM_PROGRAM");
} finally {
  process.env = originalEnv;
  Object.defineProperty(process, "platform", { value: originalPlatform });
}

console.log("✅ Step 33 smoke test passed");
