import { scoreMatch } from "../src/palette/search.js";

async function main() {
  let passed = 0;
  let failed = 0;

  function check(name: string, cond: boolean) {
    if (cond) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      failed++;
    }
  }

  // 1. scoreMatch("Switch Model", "swm", "en").score > 0；positions 包含 0, 7
  let r = scoreMatch("Switch Model", "swm", "en");
  check('scoreMatch("Switch Model", "swm", "en") > 0', r.score > 0);
  check('positions include 0 and 7', r.positions.includes(0) && r.positions.includes(7));

  // 2. scoreMatch("切换模型", "qhmx", "zh").score > 0
  r = scoreMatch("切换模型", "qhmx", "zh");
  check('scoreMatch("切换模型", "qhmx", "zh") > 0', r.score > 0);

  // 3. scoreMatch("切换会话", "切换", "zh").score > 0
  r = scoreMatch("切换会话", "切换", "zh");
  check('scoreMatch("切换会话", "切换", "zh") > 0', r.score > 0);

  // 4. scoreMatch("打开编辑器", "qq", "zh").score < 0
  r = scoreMatch("打开编辑器", "qq", "zh");
  check('scoreMatch("打开编辑器", "qq", "zh") < 0', r.score < 0);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
