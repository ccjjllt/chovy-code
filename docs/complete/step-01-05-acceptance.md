# Step 01-05 验收追补报告

> 验收日期：2026-06-18  
> 范围：`docs/step-01-*.md` 到 `docs/step-05-*.md`、`docs/complete/step-01..05`、`源码解析.md`、`D:/Desktop/cc-haha-main/` 参考点  
> 结论：Phase A 可进入下一阶段；遗留问题已修复，未触碰 B1 之后的工具协议实现。

---

## 1. 本次验收读过的依据

- `docs/README.md`
- `docs/architecture.md`
- `docs/innovations.md`
- `docs/step-01-types-and-error-model.md`
- `docs/step-02-config-and-secrets.md`
- `docs/step-03-logger-and-telemetry.md`
- `docs/step-04-fs-and-paths.md`
- `docs/step-05-cli-shell.md`
- `docs/complete/step-01-completion.md`
- `docs/complete/step-02-config-and-secrets.md`
- `docs/complete/step-03-logger-and-telemetry.md`
- `docs/complete/step-04-fs-and-paths.md`
- `docs/complete/step-05-cli-shell.md`
- `源码解析.md`

参考 `cc-haha-main` 时只取启动管线、错误/日志、secret/config、REPL raw-mode、安全边界等工程模式，没有复刻其 GrowthBook、TEAMMEM、Docker/VM sandbox、Buddy、语音等明确排除路线。

---

## 2. 发现并修复的问题

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| A1 | `config.json` / `features.json` 带 UTF-8 BOM 时 JSON.parse 失败 | Windows PowerShell `Set-Content -Encoding utf8` 会生成 BOM，导致 step-02 文件配置验收失败 | 解析前剥离 BOM |
| A2 | config/features/secrets 仍直接 `readFileSync` | step-04 后应用层 I/O 应收口到 safeFs | 新增 `safeFsSync.read()`，启动期同步读取统一走该入口 |
| A3 | config/features 仍抛普通 `Error('CONFIG_INVALID: ...')` | step-01 的统一错误模型没有真正贯通 | 改为 `ChovyError('CONFIG_INVALID', ...)` |
| A4 | logger 未识别 `ChovyError` | step-01 验收项 `chovy.error: <CODE> <message>` 只有 helper，没有 logger 接入 | logger 对 `ChovyError` 输出规范 code/message，且不打印业务错误 stack |
| A5 | provider readiness 只读 env，不读 secrets 文件 | `~/.chovy/secrets/<provider>` 会通过 CLI fail-fast，却在 provider.assertReady 再失败 | openai/scaffold provider 改用 `getSecret(provider)` |
| A6 | `mem/agent/skill/log/provider` 子命令未走统一启动管线 | 子命令绕过 `CHOVY_HOME` 建目录、feature flag、permission mode 校验 | 所有子命令 action 统一通过 `resolveCtx()` |
| A7 | 非 TTY 下无参 `chovy` 会触发 Ink raw-mode stack | CI/管道里输出不清晰，且退出像成功路径 | 非 TTY 直接输出 `CONFIG_INVALID`，提示使用 `chovy chat "..."` |

---

## 3. 实测验收

| 命令 / 场景 | 结果 |
|---|---|
| `bun run typecheck` | PASS |
| `bun run build` | PASS；未产生 `bin/` git diff |
| `bun run scripts/smoke-step-04.ts` | PASS，20 项检查通过，50KB 写入 3.17ms |
| BOM `config.json` 后 `loadConfig().provider` | PASS，返回 `kimi` |
| BOM `features.json` 后 `feature('swarm.judge')` | PASS，返回 `true` |
| secrets 文件 `~/.chovy/secrets/openai` 后 `chovy chat hello` | PASS，进入 provider scaffold 并返回 not implemented 占位 |
| 缺 key `chovy chat hello` | PASS，输出 `chovy.error: PROVIDER_NOT_READY ...` |
| 非 TTY 无参 `chovy` | PASS，输出 `chovy.error: CONFIG_INVALID interactive REPL requires a TTY ...` |
| `chovy --permission-mode nope provider list` | PASS，输出 `chovy.error: CONFIG_INVALID unknown --permission-mode ...` |
| `rg` 直接 fs 访问 | PASS，仅 `src/fs/safeFs.ts` 与 telemetry exit-hook 白名单仍直接触碰 `node:fs` |

---

## 4. 接口与边界确认

- 未修改 `Tool` / `ToolContext` / `ToolResult` 的 step-06 冻结接口。
- 未实现真实 provider 网络请求；真实接线仍属 step-17。
- 未引入新依赖。
- 未修改 `bin/chovy.js` / `bin/chovy.js.map` 的源码地位；构建验证后工作树未出现 bin diff。
- 未触碰 `.git/`、`.chovy/secrets/`、IDE 配置或用户级 dotfiles。

---

## 5. 后续建议

1. 进入 step-06 前先再次读取 `docs/step-06-tool-protocol-v2.md`，冻结 Tool v2 / ATP 接口。
2. step-06 后迁移 `echo` 工具，让 `descriptions / family / checkPermissions` 从草案可选逐步变成真实契约。
3. step-16 引入 `AbortSignal` 后，替换 step-05 REPL 当前的软中断。
4. step-17 真实 provider 接线时继续沿用 `getSecret()` / `getBaseUrl()`，不要回退到直接读 env。
