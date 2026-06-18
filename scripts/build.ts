/**
 * Build script — bundles the CLI into a single executable file with bun build.
 *
 * Output: bin/chovy.js  (a self-contained bundle with a Node shebang)
 *
 * Run with: `bun run build`
 */
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const ENTRY = resolve("src/cli/index.tsx");
const OUT_DIR = resolve("bin");
const OUT_FILE = resolve(OUT_DIR, "chovy.js");

console.log("▸ chovy-code build");
console.log(`  entry: ${ENTRY}`);

// Clean previous output
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUT_DIR,
  target: "bun",
  format: "esm",
  minify: true,
  sourcemap: "external",
  splitting: false,
  // Rename the entry output to the published bin name.
  naming: "chovy.js",
  // Ink pulls in an optional dev-only import (`react-devtools-core`) that
  // isn't installed in production. Provide an empty stub instead of leaving
  // it external, so the bundle has no unresolved runtime dependency.
  external: [],
  plugins: [
    {
      name: "stub-optional",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export default undefined;",
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  console.error("✗ Build failed:");
  for (const log of result.logs) console.error("  ", log);
  process.exit(1);
}

// Bun already emits a `#!/usr/bin/env bun` shebang for the entry chunk,
// so the output is directly executable — nothing to prepend.

const file = Bun.file(OUT_FILE);
console.log(`✓ Built → ${OUT_FILE}`);
console.log(`  size : ${(file.size / 1024).toFixed(1)} KB`);
