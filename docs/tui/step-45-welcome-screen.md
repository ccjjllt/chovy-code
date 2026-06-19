# Step 45 — WelcomeScreen 二栏布局（吉祥物 + Tips）

**Phase**: M | **依赖**: B8 (J 屏障) + step-39 (companion 集成) | **可并行**: 48 | **估时**: 3h

## 目标

实现图 1 那种「**Welcome back!** + 吉祥物（左栏）+ Tips（右栏）」的启动屏。
仅在 REPL **首次渲染**且消息列表只含 init system message 时显示；用户开始输入或第一条 assistant 回复后**永久折叠**到普通滚动区。

## 产物

```
src/screens/
└── welcome.tsx        # WelcomeScreen 二栏 + version 标 + cwd 提示

src/cli/repl.tsx       # 集成：messages 长度 ≤ 1 → 显示 WelcomeScreen
```

## 实现要点

### 1. 布局（≥ 100 cols）

```
╭─ chovy-code v0.X.Y ─────────────────────────┬─ 上手提示 ────────────────────────╮
│                                             │ 运行 /init 初始化 chovy.md         │
│            欢迎回来！                       │                                    │
│                                             │ 新功能                             │
│         🐧 (吉祥物 GIF 动画)                │ • Ctrl+P 打开命令面板              │
│                                             │ • Ctrl+, 进入设置（紫蓝主题）      │
│         chovy-default · default 模式        │ • Ctrl+L 切换中英                  │
│         D:/Desktop/...（cwd）               │                                    │
│                                             │ /release-notes 查看更多            │
╰─────────────────────────────────────────────┴────────────────────────────────────╯
```

### 2. 组件结构

```tsx
// src/screens/welcome.tsx
interface Props {
  provider: ProviderId;
  model: string;
  mode: PermissionMode;
  cwd: string;
  version: string;
}
export function WelcomeScreen(props: Props): React.ReactElement {
  const theme = useTheme();
  const caps = useTerminalCaps();
  if (caps.cols < 80) return <WelcomeNarrow {...props} />;

  return (
    <Box flexDirection="column" borderStyle={theme.borderStyle} borderColor={theme.primary}>
      <Box paddingX={1}>
        <Text color={theme.primary} bold>chovy-code v{props.version}</Text>
      </Box>
      <SplitPane
        ratio={0.4}
        left={<WelcomeMascotColumn {...props}/>}
        right={<WelcomeTipsColumn />}
      />
    </Box>
  );
}
```

### 3. WelcomeMascotColumn

```tsx
function WelcomeMascotColumn({ provider, model, mode, cwd }: Props): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text bold>{t("welcome.greet")}</Text>
      <Box marginTop={1} marginBottom={1}>
        <CompanionPlayer gifPath={resolveGifPath("idle", "default", cwd)} active cols={18}/>
      </Box>
      <Text dimColor>{`${provider}/${model} · ${mode}`}</Text>
      <Text dimColor>{shortCwd(cwd, 40)}</Text>
    </Box>
  );
}
```

`shortCwd(path, 40)` 长路径前用 `…` 替代：`…/chovy-code`。

### 4. WelcomeTipsColumn

```tsx
function WelcomeTipsColumn(): React.ReactElement {
  const theme = useTheme();
  const tips = useDynamicTips();   // step-47 提供；本步先用静态
  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Text bold color={theme.primary}>{t("welcome.tips.title")}</Text>
      <Text> </Text>
      <Text>{t("welcome.tips.init")}</Text>
      <Text> </Text>
      <Text bold color={theme.accent}>{t("welcome.whatsnew")}</Text>
      {tips.map((tip, i) => <Text key={i}>{tip.icon} {tip.text}</Text>)}
      <Text> </Text>
      <Text dimColor>{t("welcome.releasenotes")}</Text>
    </Box>
  );
}
```

step-47 实现 `useDynamicTips()`；本步用 5 条静态：palette / settings / lang / buddy / goal。

### 5. WelcomeNarrow（< 80 cols）

```tsx
function WelcomeNarrow(props: Props): React.ReactElement {
  const theme = useTheme();
  const caps = useTerminalCaps();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary}>
      <Text bold>{t("welcome.greet")}</Text>
      <CompanionPlayer gifPath={resolveGifPath("idle", "default", props.cwd)} active
                       cols={Math.min(caps.cols - 4, 20)} />
      <Text dimColor>{props.model}</Text>
      <Text dimColor>{t("welcome.tips.palette")}</Text>
    </Box>
  );
}
```

只保问候 + 吉祥物 + 一条最重要 tip（Ctrl+P）。

### 6. 集成 repl.tsx

```tsx
const welcomeDismissedRef = useRef(false);
const showWelcome = !welcomeDismissedRef.current
  && messages.length <= 1 && messages[0]?.role === "system";

useEffect(() => {
  if (messages.length > 1) welcomeDismissedRef.current = true;
}, [messages.length]);

{showWelcome ? <WelcomeScreen ... /> : null}
```

`/clear` 让 messages 重置时**不**重新显示 Welcome（dismissed 后永远不再显示）。

### 7. CompanionPlayer 复用

Welcome 内的 GIF 与 CompanionHost 的 GIF 解码缓存共享（step-37 hash 化），但 setInterval 各自管理。
Welcome dismiss 后该 player unmount + 释放 timer。
Welcome 只使用 GIF 原始颜色；theme 只控制外框、标题、Tips 色彩，不对 GIF 调色。GIF 最大 20 列，避免首屏挤压输入区。

## 接口冻结 / 不变量

- `welcome.*` i18n keys 在 step-32 字典中预留；新增必须 zh + en 同步。
- WelcomeScreen 高度上限 = `caps.rows / 2`，超出截断 tips。
- Welcome 期间用户已可输入（InputBox 仍 mount，焦点保持），第一次提交即 dismiss。
- WelcomeScreen 不引入新 hook 订阅 telemetry / fs；纯展示。
- `CHOVY_NO_COMPANION=1` 时 Welcome 不显示 GIF 区，Tips 区扩展到可用宽度。

## 验收标准

- `bun run typecheck` 通过；
- 启动 chovy → 首屏看到 Welcome 二栏，吉祥物在动；
- 输入第一条消息 → Welcome 立即消失，不再回来（重启会再次显示）；
- `/clear` 后 Welcome **不**重显；
- resize 到 60 cols → Welcome 切 Narrow 单栏；
- `scripts/smoke-step45.ts`：构造 messages=[init only] → 渲染包含 `chovy-code v` 字符串；messages 加一条 → snapshot 不包含。

## 风险

- **首屏渲染抖动**：Welcome 解码 GIF 时延 100-200ms，先显示 ASCII fallback 再切 GIF；用 onReady 回调触发渲染合并。
- **CompanionHost + Welcome 双 player**：内存翻倍但帧串复用缓存；超低内存终端可设 `CHOVY_NO_COMPANION=1`。
- **i18n key 缺失**：用 missing-key sentinel 不抛，UI 显示 `[missing: welcome.tips.lang]` 提示开发者补字典。
