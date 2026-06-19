import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const scriptsDir = join(root, "scripts");

async function runPhaseJAcceptance() {
  console.log("=== Phase J Acceptance Smoke ===\n");

  const steps = [
    "smoke-step31.ts",
    "smoke-step32.ts",
    "smoke-step33.ts",
    "smoke-step34.ts",
    "smoke-step35.tsx",
  ];

  let pass = 0;
  let fail = 0;

  for (const stepFile of steps) {
    const filePath = join(scriptsDir, stepFile);
    
    const proc = Bun.spawn(["bun", "run", filePath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code === 0) {
      pass++;
      console.log(`  PASS  ${stepFile}`);
    } else {
      fail++;
      console.log(`  FAIL  ${stepFile}`);
      console.log(`        exit code: ${code}`);
      console.log(`        output: ${stdout}\n${stderr}`);
    }
  }

  console.log(`\n=== Phase J: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

runPhaseJAcceptance().catch(err => {
  console.error("Phase J Acceptance failed:", err);
  process.exit(1);
});
