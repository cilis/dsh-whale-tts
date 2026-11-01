# dsh-whale-tts

> 这声音是育木的小鲸鱼的。

简短介绍（默认）：[README.md](README.md) · English: [README.en.md](README.en.md)

给 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) Agent 用的、与厂商无关的**语音合成插件**。

插件只做一件事：**把文本变成本地音频文件并返回路径**。它不播放、不发送、不上传音频——文件怎么用由消费方决定（QQ 桥接、视频流水线、播放器……）。

- 三个模型可见工具：`tts_synthesize`、`tts_list_voices`、`tts_status`
- 四个 provider：`openai-compatible`、`mimo`（小米 MiMo V2.5 TTS）、`sapi`（Windows 离线 SAPI）、`minimax`（空桩）
- 音色档案：预置 / 克隆 / 设计三类，最多 50 套
- 设置卡（中英双语，位于 DSH「插件」页）
- 密钥存 DSH 凭据库，插件只保存引用名，任何返回值都不含明文

## 运行要求

| 要求 | 说明 |
|---|---|
| DeepSeek Harness `>= 0.2.1-rc.4 < 0.3.0-0` | 安装时检查 `engines.dsh` |
| Node.js `>= 24.9` | DSH 运行时要求 |
| profile 含 `@deepseek-ai/dsh-base` | 它挂 `@deepseek-ai/dsh-tools`（`ctx.tools`）；内置 profile 都有 |
| Web profile（设置卡需要） | headless profile 仍可用工具、改 YAML 配置 |

> 早期方案里提到的 `dsh-tool-executor-native` 包在 DSH 0.2.1 里**不存在**；`@deepseek-ai/dsh-base` 已挂载 `dsh-tools` 与 `dsh-agent-loop`，插件所需仅此而已。

## 安装

### tarball（本地/离线推荐）

```sh
npm pack
dsh plugin --profile <profile> add file:/绝对路径/dsh-whale-tts-0.3.2.tgz
dsh --profile <profile> --dump-config | grep dsh-whale-tts   # 应出现本包层
```

包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把依赖装进 profile 并追加到
`dsh.profile.bundles`。装完重启 DSH。

### npm

若该包已发布到你的 registry：

```sh
dsh plugin --profile <profile> add dsh-whale-tts
```

### 本地目录（开发态）

```sh
dsh plugin --profile <profile> add "link:/绝对路径/dsh-whale-tts"   # 本仓库
```

### CLI 管理的 profile 一键安装

一键安装脚本在 QQBot 宿主仓库里（不在本插件仓库）；它会：备份 profile → 构建 → `npm pack`
→ `dsh plugin add` → 合并配置行 → `--dump-config` 校验：

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-whale-tts.ps1                       # 默认 qqbot
powershell -ExecutionPolicy Bypass -File tools\install-whale-tts.ps1 -Profiles desktop
powershell -ExecutionPolicy Bypass -File tools\install-whale-tts.ps1 -Rollback             # 回滚
```

**`desktop` profile 不能从 CLI 安装**：DSH 把它保留给 Electron 应用
（`error: profile "desktop" is managed exclusively by the Electron application`）。
所以 `-Profiles desktop` 时脚本只做备份与配置行合并，包本身要在应用里装：

1. 侧栏 **插件 → 添加插件 → 本地目录**：
   `<本仓库路径>`
   （或 `file:` tarball 规格），按提示重启应用；
2. 或者让应用内的 Agent 通过插件管理器安装 tarball。

`-Rollback` 会恢复备份的 `package.json` / `cordis.patch.yml`；desktop 的包仍需在插件页卸载。

## 配置

配置写在 profile 的 `cordis.patch.yml`，按 id 覆盖 bundle 自带的默认行：

```yaml
- id: whale-tts
  name: dsh-whale-tts
  config:
    provider: mimo
    fallback: [sapi]
    providers:
      mimo:
        enabled: true
        apiKeyEnv: MIMO_API_KEY
        model: mimo-v2.5-tts
        designModel: mimo-v2.5-tts-voicedesign
        cloneModel: mimo-v2.5-tts-voiceclone
        voice: 苏打
        format: wav
        timeoutMs: 20000
      sapi:
        enabled: true
    output:
      dir: 'D:\tts-audio'
    cache:
      enabled: true
      dir: 'D:\tts-audio\.cache'
    limits:
      maxChars: 120
```

> **patch 按 id 覆盖整行 config，不做深合并。** 覆盖时必须重述你要依赖的每个键；
> `providers` 字典整体替换默认值，省略的 provider/字段会回退到适配器默认值。

全部可调项（字段、默认值、含义）见英文 README 的「All configuration keys」表。
所有字段都是 **volatile**：设置卡修改后热生效，不重挂插件。

路径模板支持 `${DSH_HOME}`、`${HOME}`、`${USERPROFILE}`、`${TMP}`、`${TEMP}`，展开后必须是绝对路径。

## Provider

| id | 协议 | 密钥 | 格式 | 设计/克隆 |
|---|---|---|---|---|
| `openai-compatible` | `POST {baseURL}/audio/speech`（Bearer，原始字节） | 需要 | mp3、wav | 否 |
| `mimo` | `POST {baseURL}/chat/completions`（`api-key` 头，base64 音频） | 需要 | wav、mp3 | 是 / 是 |
| `sapi` | 本机 PowerShell `System.Speech`，断网可用 | 不需要 | wav | 否 |
| `minimax` | 空桩：抛「未实现」 | 需要 | mp3 | 否 |

回退链：

```
主 provider
  ├─ 校验类错误           → 直接失败（不重试、不回退）
  ├─ 可重试错误（超时/网络/429/5xx）→ 按 retry 重试，仍失败则回退
  ├─ 鉴权/余额/内容过滤   → 直接回退
  └─ 成功                 → 返回
回退按 fallback 顺序；禁用/平台不符/未知 provider 跳过；全失败时聚合报错并列出每家的原因。
```

更细的请求/响应与自建网关配置见 `docs/providers.md`、`docs/self-hosting.md`。

## 音色档案

三类，同一时刻只有一套「激活档案」：

| 类型 | 存什么 | 能直接合成 | 合成时怎么用 |
|---|---|---|---|
| `preset` | `presetVoiceId` | 能 | provider 语音模型 + 预置音色 |
| `clone` | `voices/` 里的参考音频 | 能 | provider 克隆模型 + `data:` URL 样本 |
| `design` | 描述 + 候选历史 | 不能（工坊记录） | 生成候选，选定后固化为 clone 档案 |

存储布局：

```
$DSH_HOME/whale-tts/
├── voices.json          # { version: 1, activeProfileId, profiles[] }
├── voices/<file>        # 克隆样本（wav/mp3）
├── design/<file>        # 设计候选（临时）
├── preview/<file>       # 设置卡试听文件（自动清理）
└── .cache/              # 合成缓存（未显式配 cache.dir 时）
```

上限：≤50 套档案、单个样本 ≤10MB。删除档案会同时删样本文件，激活档案被删后回退默认音色。

声音设计走 A 方案：**描述 → 生成 2~5 条候选 → 试听 → 选定固化成 clone 档案**；
插件不会「每句按描述现场设计」（那样音色会飘）。

## 密钥

插件只存**引用名**，不存密钥值：

```yaml
providers:
  mimo:
    apiKeyEnv: MIMO_API_KEY        # 或填 XIAOMI_TOKEN_PLAN_CN_API_KEY 复用 DSH 已有凭据
```

解析顺序（经 `ctx.credentials`，缺失时兜底 `process.env`）：DSH 凭据库
（`$DSH_HOME/.credentials.yaml`）→ 启动环境 → 项目 `.env` → `$DSH_HOME/.env`。

设置卡通过 `ctx.credentials.set()` 写入密钥，之后只显示「已配置 / 未配置」：
不回显、不显示尾号、不进日志、不进错误信息、不进工具返回值、不进浏览器 bundle。

**密钥类型**（小米 MiMo，识别只在 host 侧，只有类型字符串出 host）：

| 前缀 | 类型 | 默认 BaseURL |
|---|---|---|
| `sk-` | 按量付费 | `https://api.xiaomimimo.com/v1` |
| `tp-` | Token Plan | `https://token-plan-cn.xiaomimimo.com/v1` |
| `ttp-` | Token Plan 团队版 | `https://token-plan-cn.xiaomimimo.com/v1` |
| 其它 | 自定义 | provider 的 `baseURL` |

**安全边界（如实说明）**：DSH 把凭据存 `$DSH_HOME/.credentials.yaml`（目录 0700、
文件 0600）。这是**文件权限，不是加密**——挡得住别的系统用户，挡不住同用户下的
工具调用。想更严格就用启动环境变量注入，不落凭据库。

## 工具

### `tts_synthesize`

参数：`text`（必填）、`provider`、`voice`、`format`（wav/mp3）、`style`、`filename`。

返回（规范 JSON 值）：

```json
{
  "ok": true,
  "path": "E:\\…\\audio\\tts-20261031-221500-a1b2c3.wav",
  "relativePath": "tts-20261031-221500-a1b2c3.wav",
  "file": "tts-20261031-221500-a1b2c3.wav",
  "format": "wav",
  "provider": "mimo",
  "voice": "苏打",
  "cached": false,
  "bytes": 482133,
  "elapsedMs": 1830
}
```

三个路径字段对应不同消费方：`path` 绝对路径；`relativePath` 相对 `output.dir`
（POSIX 分隔符，消费方只接受库内文件时用它）；`file` 纯文件名。命中缓存返回
`cached: true`；若 `cache.dir` 是 `output.dir` 的子目录，相对路径可能带该子目录，
否则关掉缓存。

### `tts_list_voices`

返回 `{ providers: [{ id, capabilities, voices }], profiles, activeProfileId }`，不联网、不读密钥。

### `tts_status`

返回 provider / 回退链 / 各 provider 的 `configured`、`keyRequired`、`keyConfigured`、
`keyType`、`available`、`model`、`voice`、`baseURL`、`lastError`，以及激活音色、
缓存、输出目录、平台。**不含密钥、不含文本**，排障先跑它。

## 设置卡

client half 注册在 DSH **「插件」页**的 `dsh-whale-tts` 包下
（`plugins.bundle.config`，key = 包名）。四块：

1. **当前音色** —— 激活档案 / provider 默认音色、试听句、试听
2. **合成模型** —— 预置 / 设计 / 克隆三选一，参数区联动：
   - 预置：9 个 MiMo 音色 + 自定义 Voice ID、样本句、保存为档案
   - 设计：描述、候选数、样本句、生成候选 + 候选列表（试听 / 设为当前）、清空候选
   - 克隆：选择音频（mp3/wav ≤10MB）或填已存样本名、保存为档案
3. **音色档案库** —— 播放 / 启用 / 重命名 / 复制 / 删除
4. **输出 / 接口** —— 输出目录、格式、缓存、单次上限、provider、密钥来源
   （复用 DSH 凭据 / 手动输入）、密钥输入、密钥类型、BaseURL 覆盖、测试连接

界面文案跟随 DSH 界面语言（内嵌中英词典）。

## 开发

```sh
cd dsh-whale-tts

npm ci --ignore-scripts            # 沙箱环境：安装脚本需要 spawn
npm run build                      # tsc（host）+ rollup（client）
npm run typecheck                  # host + client
node --test --test-isolation=none test/   # 单测
node scripts/smoke.mjs             # 离线管线 smoke（不联网）
npm pack --dry-run --ignore-scripts
```

host half 用 `tsc` 按文件编译到 `lib/`（含 `.d.ts`）；browser half 用 Rollup + Sucrase
打成 DSH 从 `/plugins` 加载的 lazy-CJS factory。两者都是纯 JS 工具链——**刻意不用
原生 esbuild**，因为它要 spawn 子进程。

## 已知限制

- **不做唱歌**：能力表保留 `singing` 字段，但工具没有 `mode` 参数、不注册 sing 工具。
- **`minimax` 是空桩**：配置位在，合成抛「未实现」。
- **不做每句现设计**：设计是一次性造声，产物固化为克隆档案。
- **设置卡在「插件」页**，不在「设置」页：DSH 0.2.1 的插件配置页迁到了侧栏插件页，
  原方案里的 `settings.plugin.item` 槽在 0.2.1-rc.5 不存在。
- **设置卡需要 Web profile**；headless profile 仍有工具、配置走 YAML。
- **试听/音频经连接 RPC 以 base64 传输**：超大参考样本会让预览负载变大（受 10MB 样本上限约束）。

## 与方案的实现偏差

| 方案 | 实现 | 原因 |
|---|---|---|
| 设置卡注册 `settings.plugin.item` | `plugins.bundle.config`（key = 包名） | 该槽在 DSH 0.2.1-rc.5 不存在；插件配置页已迁到 `dsh-client-ui-plugin-manager` |
| `TypertRemoteService` + `@Remote` 作为卡片通信 | DSH connection RPC 通道（host `ctx.connection.rpc.handle` / client `rpc.call`） | 仓库外包无法生成 `ctx.remote` 需要的严格 client codec；RPC 通道在本机同版本有生产先例（dsh-mnemon），且由 DSH Connection 统一鉴权 |
| Config 字段 `.volatile()` | 辅助函数优先 `.volatile()`，否则 `.extra('volatile', true)` | `^3.18.1` 可能解析到没有该语法糖的 schemastery |
| client bundle 用 esbuild 构建 | Rollup + Sucrase | 原生 esbuild 要 spawn 二进制，受限沙箱拒绝；产物格式一致 |
| host 源码用 esbuild 打包 | `tsc` 按文件编译到 `lib/`（含 `.d.ts`） | host 不需要打包，且能顺带产出类型 |
| `sapi` 脚本放 `src/scripts/sapi.ps1` | `scripts/sapi.ps1` | tsc 不复制资源；随包分发在 `lib/` 旁边 |
| 凭据优先级「env > 凭据文件」 | 按 0.2.1 实际语义：凭据库 > 启动环境 > 项目 `.env` > 用户 `.env`；服务缺失时才兜底 `process.env` | 0.2.1 改为 stored 可写且优先 |
| profile 必须含 `dsh-tool-executor-native` | 改为 `@deepseek-ai/dsh-base` | 该包在 0.2.1 不存在 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
