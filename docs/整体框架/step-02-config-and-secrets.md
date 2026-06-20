# Step 02 — Config & Secrets

**Phase**: A | **依赖**: 无 | **可并行**: ✅ | **估时**: 3h

## 目标

在已有 `src/config/config.ts`（zod env 加载）基础上扩展为：
1. 三层配置合并（默认 < 文件 `~/.chovy/config.json` < env < CLI flag）；
2. 多 provider 密钥的统一读取与缓存；
3. 本地 feature flag 文件 `~/.chovy/features.json`。

## 产物

```
src/config/
├── config.ts        # 重构：三层合并
├── secrets.ts       # 新：密钥读取与缓存
├── features.ts      # 新：feature flag
└── index.ts
```

## 实现要点

### 1. 配置合并

```ts
export interface ChovyConfig {
  provider: ProviderId;
  model?: string;
  temperature: number;
  maxTokens: number;
  verbose: boolean;
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';
  swarm: { parallelism: number; maxSubAgents: number; budgetUSD: number };
  memory: { enabled: boolean; injectBudgetTokens: number };
  context: { softRatio: number; hardRatio: number; reserveTokens: number };
}

export function loadConfig(args?: Partial<ChovyConfig>): ChovyConfig {
  // 1. 默认
  // 2. ~/.chovy/config.json （若存在）
  // 3. process.env CHOVY_*
  // 4. args
  // → zod parse；冲突时后者覆盖前者；返回 frozen 对象。
}
```

### 2. Secrets

```ts
// src/config/secrets.ts
const ENV_KEYS: Record<ProviderId, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  glm: 'GLM_API_KEY',         // 智谱 BIGMODEL
  kimi: 'KIMI_API_KEY',       // moonshot
};

export function getSecret(p: ProviderId): string | undefined { /* env -> secrets file */ }
export function hasSecret(p: ProviderId): boolean { ... }
```

读取顺序：env → `~/.chovy/secrets/<provider>` 文件（明文，权限 0600）。**不实现** keychain 集成，作为 future。

### 3. Features

```ts
// 三种来源任一启用即视为开启：
//   ~/.chovy/features.json: { "swarm.judge": true }
//   env: CHOVY_FEATURE_SWARM_JUDGE=1
//   CLI: --feature swarm.judge
export function feature(name: string): boolean { ... }
```

### 4. Base URL 覆盖

每个 provider 支持 `<PROVIDER>_BASE_URL` 覆盖（用于自建网关 / Azure / 国内代理）。

## 验收标准

- `chovy --provider glm "hi"` 在 `GLM_API_KEY` 缺失时给出清晰报错（`PROVIDER_NOT_READY`）；
- `~/.chovy/config.json` 写入 `{"provider":"kimi"}` 后 default 命令使用 kimi；
- `feature('swarm.judge')` 在 `~/.chovy/features.json` 标 true 时返回 true。

## 参考源

- `cc-haha/src/utils/settings/`、`cc-haha/src/services/analytics/growthbook.ts`（仅作思路参考，**不**接 GrowthBook）

## 风险

- 配置文件锁竞争 → 用 `bun write` 原子写。

## 验收追补（2026-06-18）

- `config.json` / `features.json` 解析前必须兼容 UTF-8 BOM，Windows PowerShell `Set-Content -Encoding utf8` 会触发该场景。
- 配置与 feature 文件错误必须抛 `ChovyError('CONFIG_INVALID', ...)`，不再用普通 `Error('CONFIG_INVALID: ...')` 字符串前缀。
- Provider readiness 必须通过 `getSecret(provider)`，同时支持 env 与 `~/.chovy/secrets/<provider>` 文件；真实网络接线仍留给 step-17。
