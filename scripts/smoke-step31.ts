import { $ } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile } from "fs/promises";

async function run() {
  const baseTmp = join(tmpdir(), `chovy-smoke-step31-${Date.now()}`);
  console.log(`Setting up CHOVY_HOME in ${baseTmp}`);

  try {
    // Ensure CHOVY_HOME structure exists
    await mkdir(baseTmp, { recursive: true });

    // We write a small runner script so we can execute it with Bun
    const scriptPath = join(baseTmp, "runner.ts");
    const scriptContent = `
      import { setTheme, getTheme } from "${join(process.cwd(), "src/theme/index.ts").replace(/\\/g, "/")}";
      import { chovyConfigPath } from "${join(process.cwd(), "src/config/home.ts").replace(/\\/g, "/")}";
      import { readFileSync } from "fs";

      console.log("Initial theme:", getTheme().name);
      setTheme("ChovyHighContrast");
      console.log("After setTheme:", getTheme().name);

      const path = chovyConfigPath();
      const configContent = readFileSync(path, "utf-8");
      const config = JSON.parse(configContent);
      console.log("Config name:", config.theme.name);

      if (config.theme.name !== "ChovyHighContrast") {
        throw new Error("Theme not persisted to config.json");
      }
    `;

    await writeFile(scriptPath, scriptContent);

    console.log("Running smoke test...");
    
    const out = await $`bun run ${scriptPath}`.env({
      ...process.env,
      CHOVY_HOME: baseTmp,
    }).text();
    
    console.log("Runner output:");
    console.log(out);

    if (!out.includes("After setTheme: ChovyHighContrast")) {
      throw new Error("Theme failed to update");
    }
    if (!out.includes("Config name: ChovyHighContrast")) {
      throw new Error("Persisted theme name mismatch");
    }

    console.log("✅ step-31 smoke passed.");
  } finally {
    // Cleanup
    await rm(baseTmp, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
