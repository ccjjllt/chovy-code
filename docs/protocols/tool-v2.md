# Tool Protocol v2 — Author Guide

> Status: **frozen at step-06** (B1 屏障). All tools landed from step-08 onward
> MUST conform to this contract. Existing v1 tools (those that only set
> `description` and return a `string`) keep working through the back-compat
> layer documented below, but new code SHOULD adopt v2 directly.
>
> Source of truth for the contract: [`src/types/tool.ts`](../../src/types/tool.ts).
> Source of truth for the registry: [`src/tools/registry.ts`](../../src/tools/registry.ts).
> Source of truth for the ATP allocator interface: [`src/tools/describe.ts`](../../src/tools/describe.ts).

---

## 1. The 60-second tour

A v2 tool is an object that:

1. Names itself uniquely (`name: snake_case`).
2. Declares a **lean / full** description pair (`desc.lean`, `desc.full`) so
   the **Adaptive Tool Protocol (ATP)** can decide which one to inject per
   turn.
3. Lives in a **family** (`fs` / `exec` / `web` / `meta` / `custom`) used by
   ATP for same-family `full` exclusivity and by the permission engine for
   bulk gating.
4. Validates its arguments with a **Zod** schema.
5. Implements a **`checkPermissions`** hook that returns
   `{ outcome: 'allow' | 'ask' | 'deny' }`. The permission engine (step-12)
   calls this as the *first* of 6 layers.
6. Implements **`run(args, ctx)`** that returns a structured **`ToolResult`**:
   `{ ok, content, structuredOutput?, meta?, errorCode? }`.

Minimal example (the reference `echoTool`):

```ts
import { z } from "zod";
import type { Tool, ToolResult } from "../types/index.js";

export const echoTool: Tool = {
  name: "echo",
  version: 2,
  family: "meta",
  desc: {
    lean: "Echo back the provided message. Smoke-test only.",
    full:
      "Echo back the provided message verbatim. Useful for validating " +
      "the agent loop end-to-end. Returns the input unchanged.",
  },
  schema: z.object({ message: z.string() }),
  isReadOnly: true,
  canUseWithoutAsk: true,
  checkPermissions: () => ({ outcome: "allow" }),
  async run(args): Promise<ToolResult> {
    return { ok: true, content: args.message };
  },
};
```

Register it with a namespace:

```ts
registerTool(echoTool, { namespace: "meta" });
```

That's it. Steps 12 / 13 / 18 / 22 will inject permissions, hooks,
sub-agent spawn, and rendering — your tool gets them for free as long as
you sit on the v2 contract.

---

## 2. The `Tool` interface field-by-field

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Stable id, snake_case, unique across the registry. |
| `version` | recommended | Set to `2` for v2 tools; future schema bumps will key off this. |
| `family` | recommended | One of `fs` / `exec` / `web` / `meta` / `echo` / `custom`. Controls ATP same-family `full` exclusivity. |
| `desc.lean` | ✅ for v2 | One sentence, ~80–150 tokens. **Always** safe to inject. |
| `desc.full` | ✅ for v2 | Long form: examples, edge cases, safety notes. Injected only when budget allows AND the tool is relevant. |
| `desc.examples` | optional | Dropped first when budget is tight. |
| `fullTriggers` | optional | `RegExp[]`. If any matches the recent message tail, ATP forces this tool to `full`. |
| `schema` | ✅ | Zod schema describing the args. The agent validates with `safeParse` before calling `run`. |
| `userFacingName(args)` | optional | Status-line label, e.g. `"Read README.md"`. Defaults to `name`. |
| `isReadOnly` | recommended | `true` for tools that don't mutate state. The plan-mode permission engine reads this to allow read-only tools without prompting. |
| `canUseWithoutAsk` | optional | When `true`, an `ask` outcome from the engine is treated as `allow`. Use sparingly — only for safe meta tools. |
| `checkPermissions(args, ctx)` | recommended | Self-preflight. Return `{ outcome }`. The engine (step-12) calls this first; subsequent layers can still escalate or override. |
| `run(args, ctx?)` | ✅ | Returns `ToolResult` (v2) or `string` (legacy back-compat). |
| `renderResult(args, result)` | optional | Step-22 Ink renderer. Loose-typed (`unknown` → `ReactNode`) at this layer. |
| `description` | legacy | v1 single-line description. v2 tools omit this and let the registry derive it from `desc.lean`. |

---

## 3. `ToolContext` — what `run` sees

```ts
interface ToolContext {
  cwd: string;             // path resolution root
  abortSignal: AbortSignal; // honor for long-running tools
  logger: Logger;           // structured logger, NEVER use console.*
  permissions: PermissionEngine; // step-12 placeholder today
  hooks: HookEngine;             // step-13 placeholder today
  spawnSubAgent?: SpawnFn;       // step-18 placeholder today
  config: ChovyConfig;     // live snapshot — read-only
  sessionId: string;       // for memory / telemetry
  projectId: string;       // hash(cwd)
}
```

The shape is **frozen at step-06**. Future steps may add optional fields,
but renaming or removing a field requires bumping `Tool.version`.

Today, only the *cwd / abortSignal / logger / config / sessionId / projectId*
fields are reliably populated by the agent loop. The engine handles
(`permissions`, `hooks`, `spawnSubAgent`) are stubs until their respective
steps land — do **not** rely on their methods existing yet. If your tool
needs sub-agent dispatch or a permission re-check, gate it with
`if (ctx.permissions.preflight) { ... }` etc.

---

## 4. `ToolResult` — what `run` returns

```ts
interface ToolResult {
  ok: boolean;
  content: string;            // model-facing text (REQUIRED)
  structuredOutput?: unknown; // UI / programmatic consumers
  meta?: {
    filesChanged?: string[];
    cmd?: string;
    durMs?: number;
    bytes?: number;
  };
  errorCode?: ErrorCode;      // set when ok === false; see types/errors.ts
}
```

Rules of thumb:

- `content` is the *only* field the model sees. Keep it focused — the UI
  reads `structuredOutput` and `meta` separately.
- On failure, set `ok: false`, write a brief reason into `content`, and set
  `errorCode` to a stable code from `types/errors.ts` (e.g. `TOOL_DENIED`,
  `TOOL_TIMEOUT`).
- `meta.filesChanged` is the contract the harness uses to decide which
  files to re-stat / re-fingerprint after a tool run.

---

## 5. ATP — how the lean/full pick works

The full allocator lands in **step-07**. Step-06 ships a deliberately
minimal stub in `src/tools/describe.ts`:

```ts
describeTools({
  budgetTokens: 6_000,
  recentMessages: messages.slice(-6),
  lastToolCalls: ["read", "grep"],
}): DescribedTool[]
```

The stub:

1. Starts every tool at `lean`.
2. Promotes a tool to `full` *only* if it is "relevant" — its
   `fullTriggers` match the recent message tail, *or* its name appears in
   `lastToolCalls`.
3. Greedily upgrades in registration order until the budget is exhausted.
4. With `budgetTokens: 100`, no tool is ever upgraded, satisfying the
   step-06 acceptance criterion.

Step-07 will replace the body with relevance-scored selection,
same-family `full` exclusivity, and `examples` headroom decisions; the
**signature is frozen** so you can write tools that call into it today.

---

## 6. Registration & namespaces

```ts
registerTool(myTool, {
  namespace: "fs",                    // 'fs' | 'exec' | 'web' | 'meta' | custom
  enabledWhen: () => feature("foo"),  // lazy gate, evaluated on every list/get
});
```

- `namespace` mirrors the directory layout in `architecture.md §1`. A tool
  living at `src/tools/fs/read.ts` MUST register with `namespace: "fs"`.
- `enabledWhen` is evaluated **lazily** on every `listTools` / `getTool`
  call. Perfect for `feature("...")`-style flag gating; do NOT cache the
  predicate or its result.
- `listTools(filter)` accepts `{ namespace?, enabled? }`. Pass
  `{ enabled: false }` to see hidden/disabled tools (admin views only).

---

## 7. Permission preflight (`checkPermissions`)

```ts
checkPermissions(args, ctx): PermissionPreflight | Promise<PermissionPreflight>

interface PermissionPreflight {
  outcome: "allow" | "ask" | "deny";
  reason?: string;
  matchedRule?: string;   // e.g. "Bash(git push:*)"
}
```

This is **layer 1 of 6** in the engine that lands in step-12. The engine
also consults user config rules, the active permission mode, the
PreToolUse hook (step-13), the sandbox (step-14), and — only as a last
resort — the user. Your preflight is *advisory*: returning `allow`
doesn't bypass the sandbox; returning `deny` short-circuits everything.

Conventions:

- Read-only tools should return `{ outcome: 'allow' }`.
- Mutating tools should return `{ outcome: 'ask' }` by default, escalating
  to `deny` only when the args themselves violate a hard rule (e.g.
  writing into `.git/`).
- When you `deny`, set `matchedRule` to a stable string the UI can show to
  the user.

---

## 8. Back-compat with v1 tools

The harness preserves two shims so step-01 tools keep compiling:

1. **Legacy `description` field.** A v1 tool with only
   `description: "..."` still loads. The legacy descriptor view in
   `describeToolsLegacy` reads `desc.lean ?? description`.
2. **Legacy `run()` returning `string`.** The agent loop wraps a string
   return as `{ ok: true, content: <string> }` before pushing it into the
   message list. Tools that throw still produce
   `{ ok: false, content: "Error: ..." }`.

You should NOT rely on either shim for new code — they exist purely to
keep the step-01 surface compiling.

---

## 9. Checklist for a new tool

- [ ] `name`, `family`, `version: 2`.
- [ ] `desc.lean` (≤ 1 sentence) and `desc.full` (long form, examples).
- [ ] Zod `schema` with `.describe(...)` on every field.
- [ ] `isReadOnly` set explicitly (`true` / `false`).
- [ ] `checkPermissions` returns the right outcome for the args.
- [ ] `run` returns a `ToolResult`; on error sets `ok: false` and a stable
      `errorCode`.
- [ ] Registered via `registerTool(tool, { namespace })`.
- [ ] Lives under `src/tools/<namespace>/` per `architecture.md §1`.

---

## 10. Pointers to upcoming steps

| Step | Adds |
|---|---|
| 07 | The real ATP allocator (relevance scoring, family exclusivity). |
| 08 | First real tools — `fs/read`, `fs/write`, `fs/edit`, `fs/glob`, `fs/grep`. |
| 09 | `exec/bash` with AST parsing + sandbox hooks. |
| 10 | `web/search` + `web/fetch`. |
| 11 | `meta/todoWrite`, `meta/askUserQuestion`, `meta/skill`, `meta/agent`. |
| 12 | Permission engine — your `checkPermissions` becomes layer 1 of 6. |
| 13 | Hook engine — `ctx.hooks.emit('PreToolUse', ...)` becomes real. |
| 14 | Sandbox — `cwd`-anchored path-prefix-allowlist. |
| 18 | Sub-agent runtime — `ctx.spawnSubAgent` becomes real. |
| 22 | Ink UI — `renderResult` becomes a `React.ReactNode` renderer. |

When in doubt, grep the source — the contract is the type, and the type
is the contract.
