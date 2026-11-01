# 验证环境与职责边界（补充说明）

本文件只补充 `docs/validation.md` 之外的环境限制：哪些步骤已在沙箱内真实执行，
哪些必须由用户在沙箱外 / 联网环境执行。

## 沙箱内已完成（真实执行，非模拟）

- 手动构建：`node node_modules/typescript/bin/tsc -p tsconfig.json` + `node build/build-client.mjs`
- 打包完整性：`npm pack --dry-run --ignore-scripts`、真实 `npm pack --ignore-scripts`、`tar -tzf` 校验
- client bundle 冒烟：伪 `window.__ModuleLoader__` + react stub，实际加载 `lib/client.js`
- 临时 profile（`DSH_HOME` 指向仓库内 `.qa-dsh-home`）离线安装 tgz + `--dump-config` 组合验证
- 离线 smoke：`node scripts/smoke.mjs`（假 adapter，真实 TTS 管线 / 缓存 / 文件写入）
- 清理全部临时产物；真实 `~/.dsh` 未写入，未启动常驻 DSH 服务

## 必须用户在沙箱外 / 联网环境执行

| 项 | 命令 | 原因 |
| --- | --- | --- |
| 正常联网安装 | `dsh plugin --profile <p> add .\dsh-whale-tts-0.1.0.tgz` | pnpm 需从 registry 解析 `@deepseek-ai/schemastery`；沙箱禁网，本次用工作区 store 副本 + `--offline` 等价验证 |
| npm 生命周期构建 | `npm run build` / 不带 `--ignore-scripts` 的 `npm pack` | 沙箱内 npm 生命周期子进程 EPERM，已用两条 node 命令规避 |
| 真 SAPI 合成 | 配置 `provider: sapi` 后调用 `tts_synthesize` | 需父进程 spawn PowerShell，沙箱禁止 |
| 设置卡 UI 联调 | 重启 / 刷新 DSH Web 后打开插件页试听 | 本次未启动常驻服务 |
| 真机 `--dump-config` | `dsh --profile <p> --dump-config` | 已完成临时 profile 等价验证，用户机可复核 |

## 清理

仓库内临时产物（`.qa-dsh-home/`、`.qa-store/`、`.qa-*`、`*.tgz`）已删除；用户机无需额外清理。
