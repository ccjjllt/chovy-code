/**
 * step-15 system-prompt smoke test.
 *
 * Verifies the 4 acceptance criteria from `docs/step-15-system-prompt.md`:
 *   1. `buildEffectiveSystemPrompt` in plan mode appends the plan-mode note.
 *   2. The override layer short-circuits the other 4 layers.
 *   3. Same `cwd` (and same plan-mode flag) → identical `staticHash` across
 *      two independent build calls. Static text MUST NOT depend on cwd /
 *      model / memory — those live below the boundary.
 *   4. Mutating one tool's `description` flips that tool's `perToolHash`
 *      while every other entry keeps its previous value. The aggregate
 *      `toolsHash` (built only from name list) stays stable.
 *
 * Run:  bun run scripts/smoke-step15.ts
 *
 * Exits non-zero on any failure so CI / Phase D acceptance can wire it in.
 */

import {
  buildEffectiveSystemPrompt,
  CHOVY_PROMPT_DYNAMIC_BOUNDARY,
  computeShape,
  diffShape,
  splitAtBoundary,
  type SystemContext,
} from "../src/prompts/index.js";
import type { DescribedTool } from "../src/tools/describe.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ✔ ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✘ ${label}\n`);
    if (detail) process.stdout.write(`      ${detail}\n`);
  }
}

function header(title: string): void {
  process.stdout.write(`\n# ${title}\n`);
}

const baseCtx: SystemContext = {
  cwd: { cwd: "D:/Desktop/chovy-code", branch: "main", status: "clean", isGitRepo: true },
  model: { provider: "openai", model: "gpt-4o-mini", contextWindow: 128_000 },
  memoryText: "Recent task: complete step-15.",
  notesText: "",
  loadedSkills: [],
};

// ── 验收 1：plan 模式追加 plan note ────────────────────────────────────────────
header("acceptance #1 — plan mode appends 'plan mode' note");
{
  const prompt = buildEffectiveSystemPrompt({
    context: { ...baseCtx, planMode: true },
  });
  check(
    "text contains 'Plan mode (active)'",
    prompt.text.includes("Plan mode (active)"),
    `first 200 chars: ${JSON.stringify(prompt.text.slice(0, 200))}`,
  );

  const noPlan = buildEffectiveSystemPrompt({ context: { ...baseCtx, planMode: false } });
  check(
    "non-plan-mode build does NOT contain plan note",
    !noPlan.text.includes("Plan mode (active)"),
  );
}

// ── 验收 2：override 短路其他 4 层 ─────────────────────────────────────────────
header("acceptance #2 — override layer short-circuits the others");
{
  const OVERRIDE = "OVERRIDE-LAYER-ONLY-TEXT";
  const prompt = buildEffectiveSystemPrompt({
    override: OVERRIDE,
    coordinator: "should be ignored",
    agent: { role: "main", prompt: "should be ignored" },
    custom: "should be ignored",
    defaultAppend: "should be ignored",
    context: baseCtx,
  });
  check("segments has exactly one entry", prompt.segments.length === 1, JSON.stringify(prompt.segments));
  check("only segment is from 'override'", prompt.segments[0]?.from === "override");
  // `finalize` trims + appends a single trailing newline for consistency
  // with the multi-segment build path; assert content (not byte-identity).
  check("text equals the override input (trim-equal)", prompt.text.trim() === OVERRIDE);
  check("no fragment from default body leaks", !prompt.text.includes("chovy-code — Coding Agent"));
}

// ── 验收 3：同 cwd 两次构建 staticHash 相同 ────────────────────────────────────
header("acceptance #3 — staticHash is stable across runs (same cwd, same mode)");
{
  const a = buildEffectiveSystemPrompt({ context: { ...baseCtx } });
  const b = buildEffectiveSystemPrompt({ context: { ...baseCtx } });
  check(
    `staticHash equal across two builds (a=${a.staticHash} b=${b.staticHash})`,
    a.staticHash === b.staticHash,
  );

  // Different cwd / model / memory MUST flip dynamicHash but NOT staticHash.
  const c = buildEffectiveSystemPrompt({
    context: {
      ...baseCtx,
      cwd: { ...baseCtx.cwd, cwd: "/some/other/path" },
      memoryText: "different memory blob",
    },
  });
  check("staticHash unchanged when only cwd/memory differ", a.staticHash === c.staticHash);
  check("dynamicHash differs when cwd/memory differ", a.dynamicHash !== c.dynamicHash);

  // Plan mode rides static (cache-stable for the run); flipping it is
  // expected to change staticHash.
  const planned = buildEffectiveSystemPrompt({ context: { ...baseCtx, planMode: true } });
  check("planMode flip changes staticHash", a.staticHash !== planned.staticHash);

  // Boundary marker is present in normal (non-override) builds.
  check(
    "boundary marker present in default build",
    a.text.includes(CHOVY_PROMPT_DYNAMIC_BOUNDARY),
  );
  const split = splitAtBoundary(a.text);
  check("split.static is non-empty and split.dynamic is non-empty", Boolean(split.static) && Boolean(split.dynamic));
  check("split.dynamic mentions cwd", split.dynamic.includes("/Desktop/chovy-code"));
  check("split.static does NOT mention cwd", !split.static.includes("/Desktop/chovy-code"));
}

// ── 验收 4：工具描述变化 → perToolHash 变化（其它工具不动） ─────────────────────
header("acceptance #4 — perToolHash changes iff that tool's description changes");
{
  const baseTools: DescribedTool[] = [
    { name: "fs.read", description: "Read a file from disk.", schemaJson: { type: "object" }, level: "lean" },
    { name: "fs.edit", description: "Edit a file in place.", schemaJson: { type: "object" }, level: "lean" },
    { name: "exec.bash", description: "Run a bash command.", schemaJson: { type: "object" }, level: "lean" },
  ];
  const mutatedTools: DescribedTool[] = [
    baseTools[0]!,
    { ...baseTools[1]!, description: "Edit a file in place. (now with examples)" },
    baseTools[2]!,
  ];

  const prompt = buildEffectiveSystemPrompt({ context: baseCtx });
  const a = computeShape(prompt, baseTools, "gpt-4o-mini");
  const b = computeShape(prompt, mutatedTools, "gpt-4o-mini");

  check("toolsHash unchanged (name list identical)", a.toolsHash === b.toolsHash);
  check("perToolHash[fs.read] unchanged", a.perToolHash["fs.read"] === b.perToolHash["fs.read"]);
  check("perToolHash[fs.edit] CHANGED", a.perToolHash["fs.edit"] !== b.perToolHash["fs.edit"]);
  check("perToolHash[exec.bash] unchanged", a.perToolHash["exec.bash"] === b.perToolHash["exec.bash"]);

  const diff = diffShape(a, b);
  check("diff.identical === false", diff.identical === false);
  check("diff.toolsAdded === []", diff.toolsAdded.length === 0);
  check("diff.toolsRemoved === []", diff.toolsRemoved.length === 0);
  check("diff.toolsMutated === ['fs.edit']", diff.toolsMutated.length === 1 && diff.toolsMutated[0] === "fs.edit");
  check("diff.changedFields includes 'perTool'", diff.changedFields.includes("perTool"));

  // Adding a tool should produce toolsAdded; removing produces toolsRemoved.
  const expanded: DescribedTool[] = [
    ...baseTools,
    { name: "web.fetch", description: "Fetch a URL.", schemaJson: { type: "object" }, level: "lean" },
  ];
  const c = computeShape(prompt, expanded, "gpt-4o-mini");
  const diff2 = diffShape(a, c);
  check("adding a tool registers toolsAdded", diff2.toolsAdded.includes("web.fetch"));
  check("adding a tool flips toolsHash → changedFields includes 'toolsList'", diff2.changedFields.includes("toolsList"));

  // Different model id must register as 'model' change without touching tools.
  const d = computeShape(prompt, baseTools, "claude-sonnet-4-6");
  const diff3 = diffShape(a, d);
  check("model id change flagged", diff3.changedFields.includes("model"));
  check("model id change does NOT mark tools mutated", diff3.toolsMutated.length === 0);
}

// ── 完成 ──────────────────────────────────────────────────────────────────────
header("summary");
if (failures > 0) {
  process.stdout.write(`\nFAIL — ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nPASS — step-15 acceptance criteria satisfied\n");
