# Qwen3-TTS 本地部署与 `qwen-local` provider

> 适用：0.5.x 起的 `qwen-local` provider  
> 相关：[本地引擎调研](local-tts-research.md) · [产品规划](product-plan.md) · [输出接口 v1](interface-v1.md)

## 1. 它是什么

`qwen-local` 不是 DashScope 云 API，而是给 **本地 Qwen3-TTS 服务**用的 provider。

- 模型：Qwen3-TTS 开源权重，0.6B / 1.7B；
- 许可证：Apache-2.0；
- 能力：中文等 10 种语言、zero-shot 克隆、声音设计、流式；
- 插件侧：只通过 **OpenAI-compatible `POST /v1/audio/speech`** 调用，不 import PyTorch、
  不加载 GPU 模型。

当前 adapter 只实现「预设音色」的普通合成；克隆/设计需要本地服务支持额外的 voice
注册或参考音频接口，暂不在 `qwen-local` 的默认能力表里。

## 2. 先选服务方式

| 方式 | 适合 | 说明 |
| --- | --- | --- |
| vLLM-Omni | 推荐，长期运行 | 提供 OpenAI 兼容接口；Linux/WSL2/Docker 更稳，Windows 原生支持弱 |
| 官方 Python demo + FastAPI 包装 | 先验证模型 | demo 本身不是 OpenAI 兼容接口；需要包一层 `/v1/audio/speech` |
| 自建服务 | 已有推理框架 | 只要返回 raw WAV/MP3，并实现 `/v1/audio/speech` |

`qwen-local` 不负责启动服务、下载模型或管理 CUDA；这些由用户/后续 P3 sidecar
管理器完成。

## 3. 服务端要求

最小契约：

```http
POST http://127.0.0.1:8000/v1/audio/speech
Content-Type: application/json
Authorization: Bearer <optional>

{
  "model": "Qwen/Qwen3-TTS-12Hz-0.6B",
  "voice": "Cherry",
  "input": "你好，我是育木的小鲸鱼。",
  "response_format": "wav"
}
```

成功响应：`200` + 原始 WAV/MP3 字节（不是 JSON、不是 URL）。

- 不需要 key；如果本地网关有 token，配 `apiKeyEnv` 即可。
- 失败请返回 4xx/5xx + 纯文本错误；adapter 会分类为 auth/rate-limit/provider。
- 采样率/声道由服务端决定；推荐 24 kHz、单声道。

## 4. 插件配置

```yaml
- id: whale-tts
  name: dsh-whale-tts
  config:
    provider: qwen-local
    providers:
      qwen-local:
        enabled: true
        baseURL: http://127.0.0.1:8000/v1
        model: Qwen/Qwen3-TTS-12Hz-0.6B
        voice: Cherry
        format: wav
        timeoutMs: 120000
        # 本地服务有 token 时才填；没有就留空
        apiKeyEnv: ''
    output:
      dir: 'E:\DeepSeek Harness\QQBot\qq-bridge\audio'
```

字段说明：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:8000/v1` | adapter 会拼 `/audio/speech` |
| `model` | `Qwen/Qwen3-TTS-12Hz-0.6B` | 服务端实际加载的模型名 |
| `voice` | `Cherry` | 服务端支持的音色/说话人 |
| `format` | `wav` | `wav` / `mp3` |
| `timeoutMs` | `120000` | 冷启动/长句留足时间 |
| `apiKeyEnv` | 空 | 可选；指向 DSH 凭据 ref |

QQBot 场景把 `output.dir` 指到 `qq-bridge/audio`，和现有链路一致。

## 5. 验证

```text
tts_status
→ provider=qwen-local, available=true, preflight 正常

tts_list_voices
→ 能看到 qwen-local / Cherry

tts_synthesize(text="你好，我是育木的小鲸鱼。")
→ 返回 path / relativePath / file
```

如果 `tts_status` 显示 `available=true` 但合成超时，优先检查：

1. 本地服务是否真的在 `127.0.0.1:8000` 监听；
2. `/v1/audio/speech` 是否返回 raw audio，而不是 JSON/URL；
3. 模型名/音色名是否和服务端一致；
4. 首次加载是否超过 `timeoutMs`（0.6B/1.7B 冷启动可能几十秒）。

## 6. 硬件建议

- 0.6B：bf16 权重约 1.2GB，建议 **6–8GB VRAM** 起步；
- 1.7B：权重约 3.4GB，建议 **12GB 左右** 更稳；
- CPU 可跑 demo，但延迟不适合 QQBot 实时短句；
- Windows：原生 demo 可行；vLLM-Omni 服务化建议 WSL2/Docker。

以上是经验估算，不是官方最低要求；以实际模型卡和压测为准。

## 7. 当前限制

- 不自动安装 Python/CUDA，不自动下载模型；
- 不管理本地进程生命周期（P3 后续做）；
- 不通过 `/audio/speech` 支持克隆/设计（需要专门接口）；
- 本地服务不可用时，按插件 fallback 链回退云端/SAPI；
- 模型权重不进入 npm 包；参考音频/声音授权由使用者负责。
