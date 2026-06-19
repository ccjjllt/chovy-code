# Step 47 — 启动 Tips + 新手引导 + 版本提示

**Phase**: M | **依赖**: 45, 46 | **估时**: 2h

## 目标

把 WelcomeScreen 右栏的 tips 升级为：

1. **动态 tips**：根据用户使用情况（是否首次启动、是否配过 provider、是否用过 palette）智能选 5 条；
2. **新手引导**：首次启动**单步**对话（"按 Ctrl+P 看看？"），用户操作后 dismiss；
3. **版本提示**：本地比较 `~/.chovy/cache/last-version.txt` 与 当前 version → 升级时显示 release-notes 引导。

## 产物

```
src/screens/
├── tips.ts              # useDynamicTips() + getStaticTips()
└── onboarding.ts        # OnboardingState 跨会话读写

src/cli/repl.tsx         # 接：onFirstAction → dismissOnboarding
```

## 实现要点

### 1. OnboardingState

```ts
// ~/.chovy/cache/onboarding.json
export interface OnboardingState {
  v: 1;
  firstSeenAt: number;          // ms epoch
  firstActionAt?: number;       // 首次输入消息或斜杠
  paletteOpenedCount: number;
  settingsOpenedCount: number;
  buddyPettedCount: number;
  langSwitchedAt?: number;
  lastSeenVersion?: string;     // release-notes 提示用
}
```

```ts
export function loadOnboarding(): OnboardingState;
export function saveOnboarding(s: OnboardingState): void;
export function recordEvent(kind: "palette"|"settings"|"buddy"|"lang"|"firstAction", currentVersion: string): void;
```

事件触发点：

- `palette` → step-43 execAt 内追加；
- `settings` → step-48 SettingsScreen mount 内；
- `buddy` → step-40 doPet 内；
- `lang` → step-32 setLocale 内；
- `firstAction` → repl.tsx send() 第一次成功时。

### 2. useDynamicTips()

```ts
export function useDynamicTips(): Tip[] {
  const state = loadOnboarding();
  const tips: Tip[] = [];

  // 1. 永远第一条：版本提示（升级时）
  if (state.lastSeenVersion && state.lastSeenVersion !== currentVersion) {
    tips.push({ icon: "✨", text: t("welcome.upgraded", { from: state.lastSeenVersion, to: currentVersion }) });
  }

  // 2. 没用过命令面板 → 强烈推荐
  if (state.paletteOpenedCount === 0) {
    tips.push({ icon: "•", text: t("welcome.tips.palette") });
  }

  // 3. 没进过设置 → 推荐
  if (state.settingsOpenedCount === 0) {
    tips.push({ icon: "•", text: t("welcome.tips.settings") });
  }

  // 4. 没切过语言 → 推荐
  if (!state.langSwitchedAt) {
    tips.push({ icon: "•", text: t("welcome.tips.lang") });
  }

  // 5. 没摸过吉祥物 → 推荐
  if (state.buddyPettedCount === 0) {
    tips.push({ icon: "•", text: t("welcome.tips.buddy") });
  }

  // 6. 都用过了 → 显示 release-notes 入口 + goal 推荐
  if (tips.length < 3) {
    tips.push({ icon: "•", text: t("welcome.tips.goal") });
    tips.push({ icon: "•", text: t("welcome.tips.releasenotes") });
  }

  return tips.slice(0, 5);
}
```

### 3. 新手引导（OnboardingHint）

新用户首次启动（`firstActionAt === undefined`）时，HeaderBar 下方加一条 hint 行：

```
👋  按 Ctrl+P 打开命令面板，或者直接输入消息和 chovy 聊天～
```

第一次成功 send → `recordEvent("firstAction", version)` → hint 永久消失（不再显示）。

```tsx
// src/cli/repl.tsx
const onboardingShow = useMemo(() => {
  const s = loadOnboarding();
  return s.firstActionAt === undefined;
}, []);
{onboardingShow ? <OnboardingHint /> : null}
```

### 4. 版本提示

```ts
// 启动时（cli/index.tsx）
const s = loadOnboarding();
if (s.lastSeenVersion !== currentVersion) {
  s.lastSeenVersion = currentVersion;
  saveOnboarding(s);   // 写盘后再下次启动看 dynamicTips 不会重复触发
}
```

> 不主动弹 release-notes（避免打扰）；只在 dynamicTips 第一条标 `✨ 已从 vX 升级到 vY，运行 /release-notes`。
> `/release-notes` 命令本身在 step-44 通过 `cli/commandSources.ts` 进入 command store，并同步出 Ctrl+P 与 `/` 两个入口。

### 5. tips.ts 静态兜底

```ts
export function getStaticTips(): Tip[] {
  return [
    { icon: "•", text: t("welcome.tips.palette") },
    { icon: "•", text: t("welcome.tips.settings") },
    { icon: "•", text: t("welcome.tips.lang") },
    { icon: "•", text: t("welcome.tips.buddy") },
    { icon: "•", text: t("welcome.tips.goal") },
  ];
}
```

`useDynamicTips()` 内部 try/catch loadOnboarding 异常 → fallback 到 getStaticTips。

## 接口冻结 / 不变量

- OnboardingState v=1 schema 字段冻结；扩展只追加可选字段（v=2 必须支持读 v=1）；
- onboarding.json 写盘失败 → warn + in-memory 状态仍工作（不让首次新手卡住）；
- 不在 OnboardingHint 内做 React reducer/context；纯条件渲染；
- recordEvent 是同步的（写盘也同步——量极小），不阻塞主循环。

## 验收标准

- `bun run typecheck` 通过；
- 删 `~/.chovy/cache/onboarding.json` → 启动 chovy → Welcome 第一条 tip 是 palette 推荐；
- Ctrl+P 打开 → 第二次启动 → palette tip 消失，换成 settings 推荐；
- bump version → 启动出 ✨ 升级 tip 一次，再启动消失；
- `scripts/smoke-step47.ts`：mock onboarding state → useDynamicTips 返回正确 5 条。

## 风险

- **onboarding.json 多进程并发写**：用 atomic rename；最差并发场景丢一次事件计数（无害）。
- **Tips 文本过长**：i18n key 控制在 ~30 chars 内；超出 wrapByDisplayWidth 兜底。
- **OnboardingHint 视觉打扰**：用 dimColor + 图标，不闪烁；首次 send 后立即 dismiss。
