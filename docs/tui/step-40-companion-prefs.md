# Step 40 — Companion 偏好 / `/buddy` 命令 / 静音 / 彩蛋

**Phase**: K | **依赖**: 39 | **估时**: 3h

## 目标

让用户能：

- `Ctrl+B` / `/buddy pet` → 摸一下吉祥物，触发爱心动画 2.5s；
- `/buddy mute` / `/buddy unmute` → 静音 / 取消；
- `/buddy skin <name>` → 切换皮肤（默认 + 用户在 `~/.chovy/skins/<name>/` 放 5 个 .gif）；
- `/buddy stats` → 显示「你已经按了 N 次」（彩蛋）。

## 产物

```
src/companion/
├── prefs.ts                  # 用户偏好读写：muted / skin / petCount
├── pet.tsx                   # 爱心动画 overlay
└── slashBuddy.ts             # /buddy 子命令实现

src/cli/slashCommands/buddy.ts   # registry 入口（薄壳）
```

## 实现要点

### 1. prefs.ts — 写入 config.json

```ts
// src/companion/prefs.ts
// config.json:
//   companion: { muted: false, skin: "default", petCount: 0 }
export interface CompanionPrefs { muted: boolean; skin: string; petCount: number; }
export function getPrefs(): CompanionPrefs;
export function setMuted(b: boolean): void;
export function setSkin(name: string): void;
export function incPetCount(): number;     // 返回新值
```

zod schema 在 step-02 既有 ChovyConfig 上**追加**可选段（AGENTS.md §15 BOM 兼容仍生效）。
`petCount` 是计数器，跨会话累加。

### 2. pet.tsx — 爱心动画

```tsx
const HEARTS = [
  "   ♥    ♥   ",
  "  ♥  ♥   ♥  ",
  " ♥   ♥  ♥   ",
  "♥  ♥      ♥ ",
  "·    ·   ·  ",
];
export function PetHearts({ active, onDone }: { active: boolean; onDone: () => void }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFrame(f => {
        if (f + 1 >= HEARTS.length) { onDone(); return 0; }
        return f + 1;
      });
    }, 500);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const theme = useTheme();
  return <Text color={theme.error}>{HEARTS[frame]}</Text>;
}
```

CompanionHost 在 `companionBus` 收到 `{type:"pet"}` 时挂 `<PetHearts/>` 在吉祥物**正上方**一行；
2.5s 后 onDone 取消激活。pet 期间 GIF 帧切换加速（step-37 player 接受 `speedHint` prop——可选）。

### 3. slashBuddy.ts — `/buddy` 子命令

```ts
// /buddy                      → 显示帮助 + stats
// /buddy pet                   → 触发爱心
// /buddy mute / unmute         → 静音切换
// /buddy skin                  → 列出可用皮肤
// /buddy skin <name>           → 切换
// /buddy skin reset            → 回 default
// /buddy stats                 → "你已经摸过吉祥物 N 次了 :)"

export const buddyHandler: SlashHandler = async (args, ctx) => {
  const sub = args.split(/\s+/)[0] ?? "";
  if (!sub) return ctx.appendSystem(t("companion.slash.help"));
  if (sub === "pet")   return doPet(ctx);
  if (sub === "mute")  return doMute(ctx, true);
  if (sub === "unmute")return doMute(ctx, false);
  if (sub === "skin")  return doSkin(args.slice("skin".length).trim(), ctx);
  if (sub === "stats") return doStats(ctx);
  ctx.appendSystem(`未知子命令：${sub}`);
};
```

### 4. 皮肤系统

```
~/.chovy/skins/
├── cool/
│   ├── idle.gif
│   ├── work.gif
│   ├── think.gif
│   ├── done.gif
│   └── error.gif
└── pixel/
    └── ...
```

`/buddy skin` 列出 `~/.chovy/skins/*/` 目录，加上 `default`。切换时先校验 5 个 .gif 都存在（缺失 → 错误提示）。

> 严格本地文件，**不**自动下载远程包（AGENTS.md §9 红线）。后续可能加 `/buddy skin install <url>` 但本步**不**实现。

### 5. 彩蛋（克制）

- `petCount > 100` → 偶尔冒一句「我快被摸秃了…」（i18n key）；
- `petCount > 500` → 解锁隐藏 quip 集（独立 key 集合，从 zh-CN/en-US 字典加载）；
- Easter egg 不影响功能，纯文本，**不**改 GIF。

### 6. Ctrl+B 集成

step-34 keybinding 注册了 `buddy.pet`：

```tsx
// src/cli/repl.tsx 内
useKeybinding("buddy.pet", () => {
  companionRef.current?.pet();
}, { isActive: !busy });
```

## 接口冻结 / 不变量

- `CompanionPrefs` 字段冻结（B9）；扩展只追加可选字段。
- 写盘单源 = `setMuted/setSkin/incPetCount`，**不**绕过去直写 config.json。
- pet 动画时长 2.5s 写常量；与吉祥物 state 切换是**正交**的（pet 时 state 不变）。
- 皮肤验证失败 → 不切换 + telemetry warn + i18n 错误提示，**不抛**。

## 验收标准

- `bun run typecheck` 通过；
- 运行 chovy → `Ctrl+B` 触发爱心，2.5s 消失；
- `/buddy mute` → 吉祥物消失；`/buddy unmute` → 恢复；
- `/buddy skin` 列出至少 `default`；
- `/buddy stats` 显示 petCount；连按 Ctrl+B 100 次后再 `stats` 显示 100；
- 重启 chovy → petCount 跨会话保持。
- `scripts/smoke-step40.ts`：模拟 pet 5 次 → 读 config.json `companion.petCount === 5`。

## 风险

- **petCount 异常值**：用户手改 config.json 写 -1 → zod schema `nonnegative()` 拒绝（BOM 兼容路径）。
- **皮肤切换期间帧切换**：切 skin → CompanionPlayer remount → setTimeout 全清；可能丢一帧但视觉无感。
- **Ctrl+B 与终端 backspace 冲突**：某些终端把 Ctrl+H 映射到 backspace；Ctrl+B 通常安全，但 KNOWN-LIMITATIONS 注明可改。
