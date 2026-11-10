# 豆包语音合成 API（火山引擎 / Volcengine）

> 最后核对：2026-11-09（V3 文档更新于 2026-05-25，V1 文档更新于 2026-05-19）
> 官方文档：
> - 大模型 V3 HTTP Chunked/SSE：https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3
> - 大模型 V1 非流式（不推荐）：https://docs.volcengine.com/docs/doubao-voice/http-one-timecompositenon-streaming-interface-v1-not-recommended
> - 参数基本说明：https://www.volcengine.com/docs/6561/79823
> - 音色列表：https://docs.volcengine.com/docs/DoubaoVoice/Tonelist

豆包现在有**两代接口**，新接入应优先 V3：

| 接口 | 地址 | 推荐度 | 适用 |
| --- | --- | --- | --- |
| V3 HTTP Chunked | `https://openspeech.bytedance.com/api/v3/tts/unidirectional` | **推荐** | 一次性文本输入、流式音频输出；支持 1.0/2.0 音色、ICL、混音 |
| V3 HTTP SSE | `https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse` | 推荐 | 同上，事件格式更适合浏览器/流式解析 |
| V3 WebSocket 双向 | `wss://openspeech.bytedance.com/api/v3/tts/bidirection` | 实时场景 | 文本实时流式输入、音频流式输出 |
| V3 WebSocket 单向 | `wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream` | 可选 | 一次性输入、流式输出 |
| V1 HTTP 非流式 | `https://openspeech.bytedance.com/api/v1/tts` | **不推荐** | 老音色、简单 JSON；**不支持 2.0 音色** |
| V1 WebSocket | `wss://openspeech.bytedance.com/api/v1/tts/ws_binary` | 不推荐 | 老接口 |

> 关键事实：V1 **不能调用豆包语音合成 2.0 音色**（例如 `zh_female_vv_uranus_bigtts`）。
> 要 2.0 音色、ICL 2.0 或更好时延，用 V3。

## 1. V3：HTTP Chunked / SSE（推荐）

### 1.1 认证（新版控制台）

| Header | 必填 | 说明 |
| --- | --- | --- |
| `X-Api-Key` | 是 | 新版控制台 API Key |
| `X-Api-Resource-Id` | 是 | 资源/模型版本，见下表 |
| `X-Api-Request-Id` | 否 | 客户端 UUID，便于排查 |

旧版控制台改用：

```http
X-Api-App-Id: <appid>
X-Api-Access-Key: <access token>
X-Api-Resource-Id: seed-tts-2.0
```

`X-Api-Resource-Id` 决定音色范围和计费：

| 资源 ID | 用途 |
| --- | --- |
| `seed-tts-2.0` | 豆包语音合成 2.0 音色 |
| `seed-tts-1.0` | 豆包语音合成 1.0 音色（字符版） |
| `seed-tts-1.0-concurr` | 1.0 音色（并发版） |
| `seed-icl-2.0` | 声音复刻 2.0 |
| `seed-icl-1.0` / `seed-icl-1.0-concurr` | 声音复刻 1.0 |

### 1.2 请求

```http
POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
POST https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse
Content-Type: application/json
```

请求体（常用字段）：

```json
{
  "user": { "uid": "uid-123" },
  "req_params": {
    "text": "你好，我是育木的小鲸鱼。",
    "speaker": "zh_female_vv_uranus_bigtts",
    "audio_params": {
      "format": "mp3",
      "sample_rate": 24000
    }
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `user.uid` | 是 | 任意非空用户标识，便于服务端追踪 |
| `req_params.text` | 是 | 一次性输入的文本；长度以控制台/接口限制为准 |
| `req_params.speaker` | 是 | 发音人/音色 ID；2.0 音色必须配 `seed-tts-2.0` |
| `req_params.ssml` | 否 | SSML 文本；2.0 音色暂不支持 |
| `req_params.audio_params` | 是 | 音频参数对象 |
| `req_params.audio_params.format` | 否 | `mp3`（默认）/ `ogg_opus` / `pcm`；V3 流式下传 `wav` 会多次返回 header，不推荐 |
| `req_params.audio_params.sample_rate` | 否 | 8000 / 16000 / 22050 / 24000（默认）/ 32000 / 44100 / 48000 |
| `req_params.audio_params.bit_rate` | 否 | MP3 比特率；默认范围 64k–160k |
| `req_params.audio_params.emotion` | 否 | 情感，例如 `angry`；仅部分音色支持 |
| `req_params.audio_params.emotion_scale` | 否 | 情绪强度 1–5，默认 4 |
| `req_params.audio_params.speech_rate` | 否 | 语速 -50–100；100 = 2.0 倍，-50 = 0.5 倍 |
| `req_params.audio_params.loudness_rate` | 否 | 音量 -50–100；100 = 2.0 倍 |
| `req_params.audio_params.enable_timestamp` | 否 | 句级时间戳（仅 TTS 1.0 音色） |
| `req_params.audio_params.enable_subtitle` | 否 | 字幕/时间戳（2.0/ICL 2.0） |
| `req_params.additions` | 否 | 扩展参数（静音、语种、方言、缓存、水印等） |
| `req_params.model` | 否 | 仅 ICL 2.0 相关：`seed-tts-2.0-standard` / `seed-tts-2.0-expressive`；普通合成可省略 |
| `req_params.mix_speaker` | 否 | 混音，最多 3 个音色，因子和必须为 1 |

常用 `additions`：

- `silence_duration`：句尾静音 0–30000 ms；
- `explicit_language`：明确语种（如 `zh-cn`、`en`、`ja`）；
- `context_language`：参考语种；
- `explicit_dialect`：方言（目前 `zh_female_vv_uranus_bigtts` 支持 `dongbei` / `shaanxi` / `sichuan`）；
- `disable_markdown_filter` / `disable_emoji_filter`；
- `cache_config`：相同文本缓存 1 小时；
- `context_texts`：2.0 的语音指令（语速/情绪/音量/音感）；
- `section_id`：2.0 多轮上下文关联；
- `use_tag_parser`：ICL 2.0 表现力增强版的 `<cot>` 标签解析；
- `aigc_watermark` / `aigc_metadata`：AIGC 标识。

### 1.3 响应（Chunked）

每个 JSON 对象：

```json
{"code": 0, "message": "", "data": "base64 音频片段"}
```

成功结束：

```json
{"code": 20000000, "message": "ok", "data": null, "usage": {"text_words": 10}}
```

- 按顺序把 `data` 的 base64 解码后拼接；`data` 为 `null` 的帧不是音频。
- `usage` 默认不返回；需要时在请求头加
  `X-Control-Require-Usage-Tokens-Return: *` 或指定 `text_words`。
- `X-Tt-Logid` 响应头用于排查，建议记录（不含敏感信息）。

### 1.4 响应（SSE）

`/unidirectional/sse` 返回 `text/event-stream`，每条事件形如：

```text
event: 352
data: {"code":0,"message":"","data":"base64..."}

event: 351
data: {"code":0,"message":"","data":null,"sentence":{...}}

event: 152
data: {"code":20000000,"message":"OK","data":null,"usage":{"text_words":11}}
```

事件含义：

| event | 含义 |
| --- | --- |
| `352` | TTSResponse，音频片段 |
| `351` | TTSSentenceEnd，一句结束（可带时间戳） |
| `152` | SessionFinish，成功结束 |
| `153` | SessionFailed，失败 |
| `151` | SessionCancel，取消 |

SSE 暂不支持重连/断点续传；需要自己处理。

### 1.5 错误

| code | 含义 | 处理 |
| --- | --- | --- |
| `20000000` | 成功结束 | 正常 |
| `40402003` | 文本超限 | 分段/缩短 |
| `45000000` | 音色未授权/资源 ID 不匹配 | 检查 speaker 与 `X-Api-Resource-Id` |
| `quota exceeded for types: concurrency` | 并发限流 | 退避重试 |
| `55000000` | 服务端通用错误 | 重试/降级 |

## 2. V1：HTTP 非流式（不推荐）

### 2.1 认证

```http
Authorization: Bearer;${token}
Content-Type: application/json
```

注意 **Bearer 和 token 之间是分号**，不是空格。V1 的 `app.token` 官方文档说明
“无实际鉴权作用，可传任意非空字符串”，但 `appid` / `cluster` 仍需正确；
不要把这套旧鉴权与 V3 的 `X-Api-Key` 混用。

### 2.2 请求

```http
POST https://openspeech.bytedance.com/api/v1/tts
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `app.appid` | 是 | 应用 ID |
| `app.token` | 是 | 任意非空字符串（旧版说明） |
| `app.cluster` | 是 | 标准音色常用 `volcano_tts` |
| `user.uid` | 是 | 任意非空用户标识 |
| `audio.voice_type` | 是 | 音色 ID，如 `BV700_streaming` |
| `audio.encoding` | 否 | `pcm`（默认）/ `wav` / `ogg_opus` / `mp3`；wav 不支持流式 |
| `audio.rate` | 否 | 24000（默认）/ 16000 / 8000 |
| `audio.speed_ratio` | 否 | 0.1–2，默认 1 |
| `audio.volume_ratio` | 否 | 0.1–3，默认 1 |
| `audio.pitch_ratio` | 否 | 0.1–3，默认 1 |
| `audio.emotion` | 否 | 情感/风格（取决于音色） |
| `request.reqid` | 是 | 每次唯一 UUID |
| `request.text` | 是 | **1024 UTF-8 字节**上限；建议 <300 字符 |
| `request.text_type` | 否 | `plain` / `ssml` |
| `request.operation` | 是 | HTTP 只能 `query` |
| `request.silence_duration` | 否 | 句尾静音 ms，默认 125 |

```json
{
  "app": { "appid": "appid123", "token": "any-non-empty", "cluster": "volcano_tts" },
  "user": { "uid": "uid123" },
  "audio": {
    "voice_type": "BV700_streaming",
    "encoding": "mp3",
    "rate": 24000,
    "speed_ratio": 1.0
  },
  "request": {
    "reqid": "uuid",
    "text": "你好，我是育木的小鲸鱼。",
    "operation": "query"
  }
}
```

### 2.3 响应

```json
{
  "reqid": "uuid",
  "code": 3000,
  "message": "Success",
  "sequence": -1,
  "data": "base64 encoded binary data",
  "addition": { "duration": "1960" }
}
```

- `code=3000` 成功；`data` 解码后是音频。
- 错误码：`3001` 参数非法、`3003` 并发超限、`3005` 服务忙、`3010` 文本超限、
  `3011` 无效文本、`3030` 处理超时、`3040/3050` 克隆链路/音色问题。
- 鉴权失败常见 `load grant: requested grant not found`，优先检查 `appid` 和
  `Bearer;` 分号格式。

## 3. 音色与声音复刻

- V3 音色列表以官方 Tonelist 为准；2.0 音色必须配 `seed-tts-2.0`。
- 常见 2.0 音色：`zh_female_vv_uranus_bigtts`、`zh_female_xiaohe_uranus_bigtts` 等。
- 声音复刻：
  1. 在控制台通过 ICL 上传参考音频，得到 speaker ID；
  2. 合成时用对应资源 ID（`seed-icl-2.0` / `seed-icl-1.0`）；
  3. `speaker` 填复刻音色 ID；
  4. 未授权返回 `speaker permission denied` / `access denied`。
- V1 不能使用 2.0 音色；V1 的复刻链路也不支持混音。

## 4. 接入 dsh-whale-tts 的建议

> 实现状态：`doubao` provider 已实现 V3 SSE（`352` 音频帧 + `152` 完成）；
> V1、chunked、WebSocket 和 ICL 复刻未接入。

- provider id：`doubao`。
- Key 引用：
  - 新版：`DOUBAO_API_KEY`（`X-Api-Key`）；
  - 旧版：`DOUBAO_APP_ID` + `DOUBAO_ACCESS_TOKEN`（`X-Api-App-Id` / `X-Api-Access-Key`）。
- 配置字段：`resourceId`（默认 `seed-tts-2.0`）、`speaker`、`format`、`sampleRate`、
  `emotion`、`speechRate`、`loudnessRate`、`baseURL`（一般不需要）。
- **优先实现 V3 SSE**：事件边界清晰，解析比 chunked 拼接稳；如果只做非流式，
  用 chunked 收集全部 `data` 后拼接。
- 输出格式：请求 `mp3` 最省事；插件支持 `wav/mp3`，如果请求 `pcm` 需要在 adapter
  里补 WAV header，不建议首期做。
- 语速映射：
  - V3 `speech_rate`：-50–100（0.5x–2x）；
  - V1 `speed_ratio`：0.1–2；
  - 插件统一参数若用 0.5–2.0，需要按 provider 转换。
- 文本限制：V1 是 1024 UTF-8 字节（建议 <300 字）；V3 以接口/控制台限制为准，
  adapter 仍应复用插件的分段逻辑并在超限时给出清楚错误。
- 错误映射：`45000000` → auth/config；`40402003` → validation；并发限流 → rate-limit；
  `55000000` / 网络 → provider/network。
- 声音复刻是独立链路（上传/建模 + 资源 ID + speaker），不要塞进普通合成 adapter
  的首期范围。
