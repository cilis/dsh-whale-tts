# dsh-whale-tts 产品规划：聚合型 TTS 层

> 规划稿 v0.3 · 2026-11-07  
> 状态：D1（QQBot 双通道分阶段）、D2（P0 范围）、D3（本地引擎部署形态）已确认；其余决策待确认。确认前不改实现代码。

## 1. 背景与目标

`dsh-whale-tts` 现在是一个可用的 DSH TTS 插件：支持 MiMo、SiliconFlow、MiniMax、OpenAI-compatible 和离线 SAPI，提供 `tts_synthesize` / `tts_list_voices` / `tts_status` 三个工具、音色档案、设置卡和朗读按钮。但当前形态更像「几个 provider 的集合」，还不是一个稳定的 TTS 平台。

目标是把插件做成 **聚合型 TTS 层**：

1. **统一接入**：云端 API、OpenAI 兼容网关、系统语音、本地模型，都走同一套 provider 契约。
2. **统一输出**：DSH 工具、QQBot 桥接、未来的 HTTP/CLI 调用，拿到同一种 JSON 结果和同一套文件约定。
3. **模块化**：核心编排、provider、local runtime、DSH UI、桥接适配器解耦，新增一家 provider 或一个本地引擎不修改核心。
4. **本地优先可离线**：本地引擎是正式能力，不是「以后再说」；支持模型包、硬件探测、进程管理和离线回退。
5. **文档即产品**：README 必须让另一个「大肥鱼机器人」只读文档就能接入，不需要读源码。

### 非目标（本期明确不做）

- 不做播放、发送、上传：插件只产出音频文件，投递由 DSH / QQBot 负责。
- 不做模型训练、微调平台。
- 不默认为用户自动下载大模型或安装二进制；必须显式确认。
- 不在首期支持唱歌、实时双向流式演唱、复杂音频编辑。

## 2. 用户与场景

| 用户 | 场景 | 核心诉求 |
| --- | --- | --- |
| DSH 桌面用户 | 设置卡里选 provider/音色，朗读回复 | 开箱即用、失败可回退、密钥安全 |
| QQBot 运营者 | 桥接调用 TTS 生成语音发给 QQ | 稳定文件路径、统一 JSON、低延迟 |
| 其他机器人作者 | 读 README 接入 | 接口字段稳定、示例可复制、错误码明确 |
| 本地/隐私用户 | 不想把文本发到云端 | 本地模型、离线可用、模型可管理 |
| 插件开发者 | 新增 provider/引擎 | 接口小、测试可注入、不用改核心 |

## 3. 产品定位

**一句话**：给 DSH 和 QQBot 生态用的、云端 + 本地可插拔的 TTS 聚合层，输出稳定、可回退、可离线。

差异化：

- 不只是「多接几家 API」，而是 **统一能力模型 + 统一输出 + 本地运行时**。
- 对上层隐藏 provider 差异：同一套音色档案、同一套错误分类、同一套回退链。
- 本地模型与云 API 在同一张 provider 表里，可按成本/延迟/隐私/克隆能力路由。
- 文档面向「其他机器人」而不是只面向人类用户。

## 4. 设计原则

1. **契约先行**：先冻结 v1 输出 JSON 和文件语义，再改实现；只做 additive 变更。
2. **适配器隔离**：核心不 import 任何厂商 SDK；provider 只依赖注入的 runtime。
3. **统一能力表**：`speech / formats / voices / clone / design / streaming / local / hardware`。
4. **失败可解释**：错误有稳定 `code`、`kind`、`retryable`，消息不含密钥和原文。
5. **默认安全**：密钥只存 DSH 凭据引用；本地二进制白名单；模型校验和；不静默下载。
6. **渐进演进**：不一次性重写；先抽 contract/registry，再迁 provider，再加本地运行时。

## 5. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│ Consumers                                                   │
│  DSH agent tools   QQBot bridge   HTTP/CLI (future)        │
└───────────────┬───────────────────────────┬────────────────┘
                │                           │
        ┌───────▼────────┐          ┌───────▼────────┐
        │ Tool adapters  │          │ Bridge adapters│
        │ tts_* tools    │          │ RPC / HTTP / MCP│
        └───────┬────────┘          └───────┬────────┘
                └──────────────┬────────────┘
                       ┌───────▼────────┐
                       │ TTS Orchestrator│
                       │ route/fallback/ │
                       │ cache/segment   │
                       └───────┬────────┘
              ┌────────────────┼────────────────┐
      ┌───────▼───────┐ ┌──────▼───────┐ ┌──────▼────────┐
      │ Cloud Provider│ │ Local Engine │ │ System Voice  │
      │ adapters      │ │ adapters     │ │ (SAPI/Edge)   │
      └───────┬───────┘ └──────┬───────┘ └──────┬────────┘
              │                │                │
      ┌───────▼────────────────▼────────────────▼────────┐
      │ Runtime services                                  │
      │ credentials / model packs / process supervisor    │
      │ cache / voice store / text preprocessing          │
      └───────────────────────────────────────────────────┘
```

### 5.1 分层职责

- **Contracts**：公开 JSON Schema、TypeScript 类型、错误码、文件约定。
- **Orchestrator**：provider 选择、fallback、缓存、文本分段、并发/超时、结果归一化。
- **Provider adapters**：只负责「一次合成」；云 provider 发 HTTP，本地 engine 调进程/ONNX。
- **Runtime services**：凭据、模型包、进程生命周期、硬件探测、缓存、音色档案。
- **Consumers**：DSH tools、QQBot RPC/HTTP、CLI；只依赖 contracts。

### 5.2 模块化目录演进（目标）

```text
src/
  contracts/            # v1 request/result/error/catalog schemas, 无运行时依赖
  core/                 # orchestrator, cache, text, voices, chain
  providers/
    cloud/              # openai, siliconflow, minimax, qwen, doubao, ...
    local/              # piper, kokoro, sherpa, gpt-sovits, ...
    system/             # sapi, edge
  runtime/
    credentials.ts
    model-packs.ts      # install/list/verify/uninstall
    process-supervisor.ts
    hardware.ts
  tools/                # DSH tool definitions (thin)
  bridge/               # RPC/HTTP facades (thin)
  client/               # settings card
docs/
  product-plan.md
  interface-v1.md       # 公开契约（README 引用）
  providers/
  local-engines/
```

迁移策略：保留现有 `src/providers/*` 路径，先增加 `contracts/` 和 `runtime/`，再把 adapter 逐个迁入子目录；每一步保持测试通过，不做一次性大重构。

## 6. 核心接口

### 6.1 Provider 统一接口

```ts
export type ProviderKind = 'cloud' | 'local' | 'system'

export interface TtsProvider {
  readonly id: string
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilities

  synthesize(request: SynthesisRequest, config: ProviderConfig, runtime: ProviderRuntime): Promise<SynthesisResult>
  listVoices?(config: ProviderConfig, runtime: ProviderRuntime): Promise<readonly VoiceDescriptor[]>
  healthCheck?(config: ProviderConfig, runtime: ProviderRuntime): Promise<HealthResult>
}
```

现有 `ProviderAdapter` 基本就是它；新增 `kind`、可选 `healthCheck`，不破坏现有 adapter。

### 6.2 本地引擎额外接口

```ts
export interface LocalEngineRuntime extends ProviderRuntime {
  readonly engine: EngineDescriptor       // 引擎版本、可执行文件/模型目录
  readonly hardware: HardwareProfile      // CPU/GPU/内存/VRAM
  readonly process: ProcessSupervisor     // 启动/停止/健康检查/端口
  readonly models: ModelPackManager       // 已安装模型包
}

export interface EngineDescriptor {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly runtime: 'onnx' | 'subprocess' | 'http' | 'python'
  readonly license: string
  readonly platforms: readonly NodeJS.Platform[]
  readonly requiresGpu: boolean
  readonly modelFormat: 'onnx' | 'pth' | 'safetensors' | 'custom'
}
```

本地引擎不是特殊的「另一套系统」，只是 `kind: 'local'` 的 provider，额外拿到 engine/hardware/process/models。

### 6.3 路由

```ts
type RoutePolicy =
  | { mode: 'fixed'; provider: string }
  | { mode: 'fallback'; order: string[] }
  | { mode: 'auto'; prefer: 'local' | 'cloud'; allowCloud: boolean; maxCost?: number }
```

首期只做 `fixed` + `fallback`（现有行为）；`auto` 在 Phase 2 引入，必须有显式配置开关。

## 7. 统一输出契约 v1

这是 README 的核心，也是其他机器人接入的唯一依据。

### 7.1 合成请求

面向 RPC/HTTP/CLI 的规范化请求（DSH tool 参数是其子集）：

```json
{
  "schemaVersion": 1,
  "text": "你好，我是育木的小鲸鱼。",
  "provider": "auto",
  "voice": "FunAudioLLM/CosyVoice2-0.5B:alex",
  "profileId": null,
  "format": "mp3",
  "style": "温柔一点",
  "speed": 1.0,
  "language": "zh",
  "filename": "reply-{timestamp}"
}
```

字段规则：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 固定 `1`；消费者必须检查 |
| `text` | 是 | 已清洗的口语文本；长度受 `limits.maxChars` |
| `provider` | 否 | `auto` / provider id；缺省用当前配置 |
| `voice` | 否 | provider 音色 id；优先于档案 |
| `profileId` | 否 | 指定音色档案；与 `voice` 二选一，`voice` 优先 |
| `format` | 否 | `mp3` / `wav`；不支持时回退 |
| `style` | 否 | 自然语言风格；仅部分 provider 支持 |
| `speed` | 否 | 0.5–2.0；本地/云支持度写入能力表 |
| `language` | 否 | BCP-47 或 `auto` |
| `filename` | 否 | 不含扩展名；支持 `{timestamp}` / `{rand}` |

### 7.2 合成结果

```json
{
  "schemaVersion": 1,
  "ok": true,
  "audioId": "sha256:8f3c…",
  "path": "C:\\Users\\me\\.dsh\\whale-tts\\out\\reply-20261107-001122-a1b2c3.mp3",
  "relativePath": "reply-20261107-001122-a1b2c3.mp3",
  "file": "reply-20261107-001122-a1b2c3.mp3",
  "format": "mp3",
  "provider": "siliconflow",
  "providerKind": "cloud",
  "voice": "FunAudioLLM/CosyVoice2-0.5B:alex",
  "profileId": null,
  "cached": false,
  "bytes": 48213,
  "elapsedMs": 1280,
  "durationMs": 3420,
  "sampleRate": 32000,
  "channels": 1,
  "textHash": "sha256:…",
  "warnings": []
}
```

约束：

- `path` 是绝对路径；`relativePath` 相对 `output.dir`，永远用 `/`；`file` 只有文件名。
- `audioId` 用音频内容哈希，方便去重/审计；不保证跨版本稳定。
- `durationMs` / `sampleRate` / `channels` 为可选字段，由 adapter 或音频探测提供。
- `warnings` 用于非致命降级，例如「请求 wav，本地引擎只支持 mp3」。
- **不返回 base64 音频**；需要字节的消费者调用 `audio/read` 或读文件。
- 文件归调用方消费；插件不主动删除输出文件，缓存清理只影响 cache 目录。

### 7.3 错误契约

RPC/HTTP facade 使用统一错误 envelope；DSH tool 仍按工具协议抛错，但错误码一致：

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "AUTH_MISSING_KEY",
    "kind": "auth",
    "message": "credential \"SILICONFLOW_API_KEY\" is not configured",
    "retryable": false,
    "provider": "siliconflow",
    "attempts": [
      { "provider": "siliconflow", "skipped": "missing-key" }
    ]
  }
}
```

错误码建议（稳定、机器可读）：

| code | kind | retryable | 场景 |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | validation | 否 | 文本为空/超长/参数非法 |
| `AUTH_MISSING_KEY` | auth | 否 | 未配置凭据 |
| `AUTH_REJECTED` | auth | 否 | 401/403 |
| `QUOTA_EXCEEDED` | quota | 否 | 余额/配额 |
| `RATE_LIMITED` | rate-limit | 是 | 429 |
| `PROVIDER_TIMEOUT` | timeout | 是 | 超时 |
| `PROVIDER_UNAVAILABLE` | network/server | 是 | 连接失败/5xx |
| `LOCAL_ENGINE_NOT_READY` | local | 是 | 模型未安装/进程未启动 |
| `CONTENT_FILTERED` | content-filter | 否 | 内容被拒 |
| `ALL_PROVIDERS_FAILED` | provider | 视 attempts | 回退链全失败 |

消息中禁止出现：API key、完整文本、参考音频内容。

### 7.4 能力与状态

`tts_list_voices` 目标结果（在现有字段上追加）：

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "piper",
      "kind": "local",
      "capabilities": {
        "speech": true,
        "singing": false,
        "formats": ["wav"],
        "voices": [{ "id": "zh_CN-huayan-medium" }],
        "requiresKey": false,
        "voiceDesign": false,
        "voiceClone": false,
        "local": true,
        "streaming": false,
        "hardware": { "requiresGpu": false }
      }
    }
  ],
  "profiles": [],
  "activeProfileId": null
}
```

`tts_status` 追加：

- `schemaVersion`
- 每个 provider 的 `kind`、`health`、`installedModels`、`processState`（本地）
- `routes`：当前 provider/fallback/auto 策略
- 不返回密钥值。

### 7.5 兼容策略

- v1 只做 **additive**：现有 `ok/path/relativePath/file/format/provider/voice/cached/bytes/elapsedMs` 保留。
- 新消费者必须检查 `schemaVersion`，未知字段忽略。
- 破坏性改动（字段删除/语义变化）走 v2，至少提前一个 minor 版本双写/弃用提示。

## 8. Provider 矩阵

### 8.1 云端

| id | 类型 | 状态 | 语音 | 克隆/设计 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `mimo` | cloud | 已接 | wav/mp3 | 是/是 | 当前默认，Token Plan |
| `siliconflow` | cloud | 已接 | mp3/wav | 否 | OpenAI 兼容，CosyVoice2 |
| `minimax` | cloud | 已接 | mp3/wav | 否（后续） | `t2a_v2`，hex 音频 |
| `openai-compatible` | cloud | 已接但隐藏 | mp3/wav | 否 | OpenAI/兼容网关 |
| `qwen` | cloud | 待接 | wav | 复刻/设计（WebSocket） | DashScope URL 下载 |
| `doubao` | cloud | 待接 | mp3/wav | ICL 1.0/2.0 | V3 chunked/SSE |
| `azure` | cloud | 待接 | mp3/wav | 自定义神经语音 | SSML |
| `elevenlabs` | cloud | 待接 | mp3 | 是 | 英文/多语种 |
| `fish-audio` | cloud | 待接 | mp3/wav | 是（reference_id） | 简单 REST |

### 8.2 本地

| 引擎 | 运行时 | 硬件 | 首期优先级 | 说明 |
| --- | --- | --- | --- | --- |
| Piper | ONNX / 可执行 | CPU | P1 | 轻量、快、离线，适合 Windows |
| Kokoro | ONNX | CPU | P1 | 质量好，模型小 |
| sherpa-onnx | ONNX | CPU | P1 | 多模型、多语言，工程成熟 |
| SAPI | 系统 | Windows | 已有 | 当前离线回退 |
| GPT-SoVITS | Python/HTTP | GPU（可选 CPU） | P2 | 克隆强，部署重 |
| CosyVoice2 | Python/HTTP | GPU | P2 | 中文/克隆，依赖多 |
| Fish Speech | Python/HTTP | GPU/CPU | P2 | 多语种、克隆 |
| IndexTTS | Python/HTTP | GPU | P3 | 情感/克隆，实验性 |

首期不要同时上四个 GPU 引擎；先把 **Piper + Kokoro + sherpa-onnx** 的本地框架跑通，再按需求接克隆引擎。

## 9. 本地 TTS 接入方案

> 引擎对比、许可证和选型细节见 [local-tts-research.md](local-tts-research.md)。
>
> **2026-11-07 复核备忘**：Piper 当前维护库已转 GPL-3.0（原 MIT 仓库归档）；新增
> ZipVoice（Apache-2.0，123M，CPU 中英文克隆）和 Qwen3-TTS（Apache-2.0，GPU）候选。
> 原路线图的「Piper 先行 / GPT-SoVITS 先行」需要按复核结论调整，**待确认后再改路线图**。

### 9.1 部署形态（2026-11-07 确认）

**不采用 Ollama。** Ollama 是 LLM/GGUF 文本推理运行时，没有标准的 TTS 音频输出接口；TTS 还需要采样率、参考音频、声码器和音频后处理，和 Ollama 的文本 token 推理不是一类东西。技术上可以给 Ollama 写自定义 runner，但那是给 Ollama 做插件，不是给本插件做本地引擎。

| 形态 | 适用引擎 | 插件职责 | 用户前提 |
| --- | --- | --- | --- |
| **ONNX/CLI（P2 默认）** | sherpa-onnx、ZipVoice、Kokoro ONNX | 下载/校验模型包，spawn 白名单 CLI，读临时 WAV | 无需 Python/CUDA |
| **Python sidecar（P3）** | GPT-SoVITS、CosyVoice3、Qwen3-TTS、VoxCPM2 | 启动/守护进程，端口/健康检查/超时，HTTP 调用 | 独立 venv/conda + GPU/CUDA（可选 CPU） |
| **External HTTP（P4，可选）** | 任意 OpenAI-compatible TTS、Docker/远程服务 | 只配置 baseURL/key/model，不管理进程 | 用户自己起服务 |

原则：

- 优先 CLI，不把 ONNX runtime 以 native addon 嵌入 DSH 进程；
- GPU 引擎不把 PyTorch/CUDA 塞进 DSH 或 npm 包，必须独立环境；
- 外部 HTTP 是高级用户的逃生口，不是默认路径；
- 本地失败可回退云端或 SAPI，不阻塞主流程。

### 9.2 模型包管理器

```json
{
  "id": "kokoro-82m-zh",
  "engine": "sherpa-onnx",
  "version": "1.0.0",
  "voices": [{ "id": "zf_xiaobei", "language": "zh-CN" }],
  "files": [{ "path": "model.onnx", "sha256": "…" }],
  "license": "Apache-2.0",
  "sizeBytes": 320000000,
  "hardware": { "requiresGpu": false, "minRamMb": 1024 },
  "source": "https://…"
}
```

要求：

- 安装前显示来源/大小/许可证，用户确认后才下载。
- 下载后校验 sha256；安装目录 `stateDir/models/<engine>/<pack>`。
- 支持 list/install/remove/verify；损坏时标记而不是崩溃。
- 不在 npm 包内携带大模型。

### 9.3 硬件与进程

- `HardwareProfile`：CPU、内存、平台、可选 GPU/VRAM；只读探测，不上报。
- `ProcessSupervisor`：启动、健康检查、端口分配、日志 ring buffer、超时、退出清理。
- 每个本地进程一个单例锁；DSH 重启后恢复；失败时 `LOCAL_ENGINE_NOT_READY`，可回退云端。
- 并发限制按引擎配置；GPU 引擎默认串行。

### 9.4 安全与许可

- 二进制/脚本白名单，模型校验和，安装路径禁止目录穿越。
- 本地 HTTP 只绑 127.0.0.1，随机端口，短时 token。
- 许可证元数据随模型包保存；README 提示用户自行确认商用/再分发许可。
- 不把本地模型文件打进 npm/GitHub Release。

### 9.5 安装与设置页

设置卡新增「本地引擎」页，流程固定为：

1. **引擎列表**：sherpa-onnx / ZipVoice / Qwen3-TTS / GPT-SoVITS…，显示已安装/运行中/不可用。
2. **模型包**：语言、大小、许可证、CPU/GPU 要求、预计磁盘占用；安装前必须确认来源和许可。
3. **安装**：下载 → sha256 校验 → 解压到 `stateDir/models/<engine>/<pack>`；失败保留旧版本。
4. **运行**：启动/停止/重启、端口、健康状态、最近日志（脱敏，不含文本/密钥）。
5. **测试**：用固定短句试听，显示 RTF、首句延迟、provider/engine 版本。
6. **回退**：本地不可用时按 `local → cloud → SAPI` 顺序回退，并在 `tts_status` 标出原因。

## 10. README/产品说明页规划

README 不只写「怎么装」，要成为**接入规范**。建议结构：

1. **Hero**：一句话定位、支持矩阵、badge。
2. **Quick start**：npm / tgz / DSH 插件页三条路径。
3. **For bot authors（重点）**：
   - 统一输出 JSON 完整示例；
   - 字段表（类型/必填/语义）；
   - 文件约定（绝对路径、相对路径、格式、所有权、缓存）；
   - 错误 envelope + 错误码表；
   - TypeScript / Python / curl 三种调用示例；
   - 「最小接入 checklist」。
4. **Providers**：云端/本地矩阵，能力、格式、克隆/设计、密钥引用。
5. **Local engines**：安装模型包、硬件要求、启动/停止、离线验证。
6. **DSH 集成**：三个工具的参数/返回、朗读按钮。
7. **QQBot 桥接**：主通道是 agent tool + `qq_send_voice`；P4 的可选 HTTP facade 只作为 thin adapter，文件交付注意点。
8. **配置**：provider、fallback、cache、output、limits。
9. **安全与隐私**：密钥、文本、参考音频、日志。
10. **兼容与版本**：`schemaVersion`、DSH 版本范围、弃用策略。
11. **Troubleshooting**：错误码 → 处理动作。
12. **开发/测试**：新增 provider/engine 的步骤。

README 必须有一节明确写：

> **输出接口是稳定契约，不是内部实现细节。** 其他机器人可以只依赖本文档接入，不需要读 TypeScript 源码。

## 11. 路线图

| 阶段 | 版本 | 交付 | 退出标准 |
| --- | --- | --- | --- |
| P0 契约与文档 | 0.5.x | `docs/interface-v1.md`、README 接口章节、provider 矩阵、错误码、`tts_status` preflight（`output.dir` vs QQBot `audio/`） | 另一个机器人只看文档能写出调用代码；现有测试全过 |
| P1 云端聚合 | 0.6.0 | provider SDK/registry 重构、Qwen/Doubao/OpenAI 可选、auto/fallback 路由、统一错误 | 新增 provider 不改 core；至少 6 家可用；契约测试 |
| P2 本地 CPU | 0.7.0 | local runtime、Piper/Kokoro/sherpa、模型包管理、设置卡本地页、离线回退 | 断网可合成；模型安装/卸载/校验；Windows 真机 |
| P3 本地克隆/GPU | 0.8.0 | GPT-SoVITS/CosyVoice/Fish sidecar、进程监督、GPU 探测、克隆档案跨引擎 | 至少一个克隆引擎端到端；资源/超时可控 |
| P4 对外 facade（可选） | 0.9.0 | loopback + token 的 HTTP `/tts/v1/*`（thin facade）、CLI、非 DSH 消费者示例 | 有真实外部消费者；契约一致；不替代 agent 通道 |

估算（单人，熟悉代码后）：

- P0：2–3 天
- P1：5–8 天
- P2：8–12 天
- P3：10–15 天（取决于引擎）
- P4：4–6 天

## 12. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 云 API 字段/模型漂移 | provider 失效 | 契约测试 + 版本化 adapter + 错误码 |
| 本地引擎依赖/许可复杂 | 安装失败、法律风险 | 模型包元数据、显式确认、白名单、文档 |
| GPU 环境差异 | 超时/崩溃 | 硬件探测、串行、超时、回退云端 |
| 包体积膨胀 | 安装慢 | 模型不打包，按需下载 |
| 进程/端口管理 | Windows 僵尸进程 | supervisor + 锁 + 健康检查 + 退出清理 |
| 统一输出破坏旧消费者 | 桥接中断 | additive v1、双写/弃用、契约测试 |
| 密钥/文本泄漏 | 安全事故 | 凭据引用、redact、日志审计、测试断言 |
| 本地模型质量不稳定 | 用户失望 | 能力表标注质量/延迟/语言；默认云端 |

## 13. 成功指标

- 新增一个云 provider ≤ 1 天，不改 core。
- 新增一个本地引擎 ≤ 3 天（框架稳定后）。
- 断网时至少一个本地引擎可用，fallback 成功率 ≥ 99%。
- 统一契约测试覆盖所有 provider 的 request/result/error。
- README 接入示例可复制运行；外部机器人按文档接入无需读源码。
- 密钥/原文泄漏测试 0 失败。
- p95 合成延迟：云 ≤ 3s（短文本），本地 CPU ≤ 2s（短文本）。

## 14. 已确认决策

### D1. QQBot 接入：双通道，分阶段（2026-11-07 确认）

**结论**：现阶段保留「DSH agent tool + `qq_send_voice`」主通道；P0 只固化契约与目录约定；HTTP `/tts/v1/*` 放 P4，作为可选 thin facade，不替代 agent 通道。

理由：

1. QQBot 发语音是模型主动表达的强行为，「说什么、要不要说」由 agent 决定；桥接直连会把表达决策搬进桥接，复制一套逻辑。
2. 当前真正缺的是稳定输出契约、错误码、文件语义，以及 `output.dir` 与 `qq-bridge/audio` 的显式约定；这些不依赖传输层。
3. HTTP facade 需要额外的端口、鉴权、进程生命周期和错误处理；等出现非 agent 消费者或确定性调用需求时再加。
4. 未来 facade 必须是同一 `TtsService` 的 thin adapter，不能另写一套 provider/编排逻辑。

### D2. P0 范围（2026-11-07 确认）

P0 只做文档与契约，不改现有行为：

- `docs/interface-v1.md`：统一请求/结果/错误 schema、文件约定、错误码。
- README 输出接口章节：字段表、TS/Python/curl 示例、最小接入 checklist。
- `tts_status` preflight：检查 `output.dir` 是否等于 QQBot 语音库目录，不一致时给出明确警告。
- 不新增 HTTP、不改 provider 行为、不升大版本。

### D3. 本地引擎部署形态（2026-11-07 确认）

**结论**：不采用 Ollama；本地 TTS 按三种形态部署：

- **P2 / CPU 默认**：sherpa-onnx 预编译 CLI + 模型包；插件托管进程，不需要 Python/CUDA。
- **P3 / GPU**：Qwen3-TTS、CosyVoice3、GPT-SoVITS、VoxCPM2 等独立 Python sidecar；插件负责启动、端口、健康检查和超时。
- **P4 / 可选**：外部 OpenAI-compatible TTS HTTP 服务，插件只配置 baseURL/key/model，不管理进程。

理由：

1. Ollama 是 LLM/GGUF 文本运行时，没有标准 TTS 音频接口；给 Ollama 写 TTS runner 等于维护另一套引擎。
2. CPU 引擎用 CLI 最轻，用户体验最好，也避免 native addon 的 ABI/打包问题。
3. GPU 引擎的 PyTorch/CUDA 依赖必须隔离在独立环境，不能塞进 DSH/npm。
4. 外部 HTTP 服务是高级用户的逃生口，适合 Docker/远程/自建；不是默认路径。
5. 插件只做「生命周期 + HTTP/CLI 适配」，不复制各引擎的推理逻辑。

## 15. 待确认决策

1. **本地引擎优先级**：先做 CPU（sherpa-onnx + Kokoro/ZipVoice）还是先做 GPU（Qwen3-TTS）？
2. **包结构**：保持单包 `dsh-whale-tts`（内部模块化），还是拆成 `core` / `providers` / `local` 多个 npm 包？我建议先单包，稳定后再拆。
3. **首个实现切片**：P0 之后先做 P1（Qwen/Doubao + registry 重构），还是先做 P2（本地 CPU）？
4. **本地模型分发**：是否允许插件在用户确认后从 GitHub / HuggingFace 下载模型？还是只支持用户手动放置？
5. **README 语言**：中文为主 + 英文镜像，还是先只写中文？
6. **Piper 处理**：用 sherpa 跑 Piper 格式模型，还是把 `piper1-gpl` 作为外部可选依赖（需接受 GPL-3.0）？

确认这些之后，我再拆成具体任务和版本计划；在确认前不改代码。
