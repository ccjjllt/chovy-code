# Step 52 — 重构 ConfigWizard ↔ SettingsScreen 共享逻辑

**Phase**: N | **依赖**: 49, 50, 51 | **估时**: 3h

## 目标

让 `chovy config` CLI 子命令、REPL `/config` slash、Settings → Provider tab **三处入口**复用同一套
SettingsField 写入路径。**外部行为完全不变**（AGENTS.md §26 配置入口不变量），只重构内部。

## 产物

```
src/cli/configWizard.ts   # 重构：所有写入走 SettingsField.write，不直写 config.json
src/screens/settings.tsx  # 暴露 runFieldOnce(fieldId) helper 给 wizard 用
src/cli/index.tsx         # chovy config CLI 子命令路由调 wizard，无变化
```

## 实现要点

### 1. 现状回顾（AGENTS.md §26）

既有 ConfigWizard：raw mode 选 provider → 输入 API key → 写 `config.json` + `secrets/<provider>`。
痛点：写入逻辑与 SettingsScreen 各自一份；改一处忘改另一处导致漂移。

### 2. 抽公共写入

```ts
// src/screens/settings.tsx 暴露：
export async function runFieldOnce(fieldId: string, value: string): Promise<void> {
  const f = listSettingsFields().find(x => x.id === fieldId);
  if (!f) throw new ChovyError("INTERNAL", `unknown setting: ${fieldId}`);
  const err = f.validate?.(value);
  if (err) throw new ChovyError("CONFIG_INVALID", err);
  await f.write(value);
}
```

### 3. ConfigWizard 重构

```ts
// src/cli/configWizard.ts（重构后）
export async function runConfigWizard(opts?: { nonInteractive?: { provider?: string; model?: string; apiKey?: string } }) {
  // 非交互分支：直接调 runFieldOnce
  if (opts?.nonInteractive) {
    if (opts.nonInteractive.provider) await runFieldOnce("provider.current", opts.nonInteractive.provider);
    if (opts.nonInteractive.model)    await runFieldOnce("provider.model", opts.nonInteractive.model);
    if (opts.nonInteractive.apiKey)   await runFieldOnce("provider.apiKey", opts.nonInteractive.apiKey);
    return;
  }
  // 交互分支：原 raw mode UI，但 commit 路径改成 runFieldOnce
  const provider = await pickProviderInteractive();
  await runFieldOnce("provider.current", provider);
  const model = await pickModelInteractive(provider);
  await runFieldOnce("provider.model", model);
  if (!hasSecret(provider)) {
    const key = await readSecretInteractive(provider);
    await runFieldOnce("provider.apiKey", key);
  }
}
```

**关键不变量**（AGENTS.md §26 复述）：

- API key 仍只写 `~/.chovy/secrets/<provider>`（runFieldOnce → SettingsField → writeSecret）；
- config.json **不**包含任何 secret 字段（saveConfigPatch + stripSecretFields 双重保险）；
- 非交互模式 `--non-interactive --provider --model --api-key` flag 全部走 runFieldOnce 路径；
- 非 TTY 下 `chovy config`（无 --non-interactive）仍报 `CONFIG_INVALID` + 提示用 --non-interactive 或手编 files；
- `bin/chovy.js` / `bin/chovy.js.map` 构建产物 hash **必须不变**（外部 surface 同）。

### 4. /config slash 命令

```ts
// src/cli/slashCommands.ts 既有 /config handler
export const configHandler: SlashHandler = async (args, ctx) => {
  await ctx.config.run();   // 调 ReplCtx.config.run() → runConfigWizard()
};
```

ReplCtx.config.run 实现内部直接 `await runConfigWizard()`——同 wizard 路径。

### 5. Settings → Provider tab

无改动（step-49 已经实现）；Provider tab 内 fields 的 write 是 SettingsField.write，与 wizard 路径合流。

### 6. 单元层 commit 路径图

```
chovy config (CLI)         /config (REPL)         Ctrl+, → Provider tab
       │                          │                          │
       ▼                          ▼                          ▼
   runConfigWizard           runConfigWizard            FieldRow → setDirty → commitDirty
       │                          │                          │
       └────────────┬─────────────┘                          │
                    ▼                                        │
             runFieldOnce(fieldId, value)                    │
                    │                                        │
                    └──────────┬─────────────────────────────┘
                               ▼
                       SettingsField.write
                               │
                               ▼
                    saveConfigPatch / writeSecret
                               │
                               ▼
                  ~/.chovy/{config.json | secrets/*}
```

### 7. 测试

- `scripts/smoke-step52.ts`：
  - 跑 `chovy config --non-interactive --provider openai --model gpt-4o --api-key sk-test`
  - 断言 `config.json.provider === "openai"`、`secrets/openai` 内容 === "sk-test"；
  - 断言 `config.json` JSON 不含 `apiKey` / `secret` 字符串（grep 0 命中）。
- 既有 step-26 / 配置入口 smoke 不应该 break（`bun run smoke` 全过）。

## 接口冻结 / 不变量

- `runConfigWizard` 函数签名**不变**；调用方（CLI / slash）零修改；
- `runFieldOnce` 是新增公共 helper，仅服务 wizard；外部模块**不**直接调（防滥用）；
- API key 写入路径单源 = `provider.apiKey` SettingsField.write，绕过即视为违反 §26；
- `bin/chovy.js` 行为字节级一致（不改构建配置，仅 src 内部重构）。

## 验收标准

- `bun run typecheck` 通过；
- `bun run smoke` 全过（包含既有 §26 配置入口 smoke 无 regression）；
- 三入口手测：`chovy config` / `/config` / Ctrl+,→Provider 全都能改 provider/model/apiKey，写入路径相同；
- `bin/chovy.js` 构建后 hash 与重构前一致（脚本 sha256 比对）；
- 非交互 `chovy config --non-interactive --provider deepseek --model deepseek-chat --api-key xxx` → 静默成功；
- 非 TTY 下 `chovy config` 不带 flag 报 CONFIG_INVALID。

## 风险

- **wizard 顺序耦合**：原版本 wizard 有「先 provider，后 model 选项才正确」的隐式依赖；runFieldOnce 串行调用保持顺序。
- **provider.apiKey validate 在 SettingsField 是 nonempty**：wizard 输入空 key 路径要在 wizard 内部就拒绝（避免 API 报错），不依赖 validate。
- **deep merge 删除字段**：用户手编 config.json 删了 model 字段 → wizard 自动写新；deep merge 不丢其它字段。
