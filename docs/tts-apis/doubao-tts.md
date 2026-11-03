# 豆包语音合成 API（火山引擎 / Volcengine）

> 最后核对：2026-11-03
> 官方文档：
> - 小模型 HTTP 非流式：https://docs.volcengine.com/docs/doubao-voice/http-interface-one-time-composition-non-streaming
> - 参数基本说明：https://www.volcengine.com/docs/6561/79823
> - 大模型 V3 HTTP Chunked/SSE：https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3
> - 大模型音色列表：https://docs.volcengine.com/docs/DoubaoVoice/Tonelist

豆包有**两套接口**，不要混用：

| 接口 | 地址 | 适用 |
| --- | --- | --- |
| 小模型 HTTP 非流式 | `https://openspeech.bytedance.com/api/v1/tts` | 老音色、简单 JSON、一次性返回 base64 |
| 大模型 V3 | `https://openspeech.bytedance.com/api/v3/tts/unidirectional`（chunked）或 `/sse` | 豆包语音合成 1.0/2.0、声音复刻（ICL）、更好音质 |
| 大模型 V3 WebSocket | `wss://openspeech.bytedance.com/api/v3/tts/bidirection` | 双向流式、实时交互 |

## 1. 小模型 HTTP（v1）

### 认证

```http
Authorization: Bearer;${token}
Content-Type: application/json
```

注意 **Bearer 和 token 之间是分号**，不是空格；`appid`、`token`、`cluster`
都在控制台获取。

### 请求

```http
POST https://openspeech.bytedance.com/api/v1/tts
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `app.appid` | string | 是 | 应用 ID |
| `app.token` | string | 是 | 访问令牌 |
| `app.cluster` | string | 是 | 业务集群；标准音色常用 `volcano_tts`，复刻音色不同 |
| `user.uid` | string | 是 | 任意非空用户标识，便于日志追踪 |
| `audio.voice_type` | string | 是 | 音色类型/声音 ID，如 `BV700_streaming`、`zh_female_wanqudashu_moon_bigtts` |
| `audio.encoding` | string | 否 | `pcm`（默认）/ `wav` / `ogg_opus` / `mp3`；wav 不支持流式 |
| `audio.rate` | int | 否 | 24000（默认）/ 16000 / 8000 |
| `audio.speed_ratio` | float | 否 | 语速 0.2–3，默认 1 |
| `audio.volume_ratio` | float | 否 | 音量 0.1–3，默认 1 |
| `audio.pitch_ratio` | float | 否 | 音高 0.1–3，默认 1 |
| `audio.emotion` | string | 否 | 情感/风格（取决于音色） |
| `audio.language` | string | 否 | 语种，如 `cn` |
| `request.reqid` | string | 是 | 每次唯一（UUID） |
| `request.text` | string | 是 | 文本，**1024 UTF-8 字节**上限；复刻音色不受此限但 HTTP 有 60s 超时 |
| `request.text_type` | string | 否 | `plain` / `ssml`，默认 plain |
| `request.operation` | string | 是 | HTTP 只能 `query` |
| `request.silence_duration` | int | 否 | 句尾静音，毫秒，默认 125 |
| `request.with_frontend` | 0/1 | 否 | 配合 `frontend_type=unitTson` 返回音素级时间戳 |
| `request.with_timestamp` | 0/1 | 否 | 新版时间戳，保留原文数字/符号 |

```json
{
  "app": { "appid": "appid123", "token": "access_token", "cluster": "volcano_tts" },
  "user": { "uid": "uid123" },
  "audio": {
    "voice_type": "BV700_streaming",
    "encoding": "mp3",
    "rate": 24000,
    "speed_ratio": 1.0,
    "volume_ratio": 1.0,
    "pitch_ratio": 1.0
  },
  "request": {
    "reqid": "5b8c2f7e-...",
    "text": "字节跳动语音合成",
    "text_type": "plain",
    "operation": "query",
    "silence_duration": "125"
  }
}
```

### 响应

```json
{
  "reqid": "5b8c2f7e-...",
  "code": 3000,
  "message": "Success",
  "sequence": -1,
  "data": "base64 encoded binary data",
  "addition": { "duration": "1960" }
}
```

- `code=3000` 成功；`data` 是 base64，解码后就是音频二进制。
- 错误码：`3001` 参数非法、`3003` 并发超限、`3005` 服务忙、`3010` 文本超限、
  `3011` 无效文本、`3030` 处理超时、`3040/3050` 克隆链路/音色问题。
- 鉴权失败常见报错：`load grant: requested grant not found`，优先检查
  `appid/token` 和 `Bearer;` 分号格式。

## 2. 大模型 V3（推荐新接入）

### 鉴权（新版控制台）

| Header | 必填 | 说明 |
| --- | --- | --- |
| `X-Api-Key` | 是 | 新版控制台的 API Key |
| `X-Api-Resource-Id` | 是 | `seed-tts-2.0`（2.0 音色）、`seed-tts-1.0`、`seed-tts-1.0-concurr`；复刻用 `seed-icl-2.0` / `seed-icl-1.0` / `seed-icl-1.0-concurr` |
| `X-Api-Request-Id` | 否 | 客户端请求 ID，UUID |

旧版控制台改用 `X-Api-App-Id` + `X-Api-Access-Key` + `X-Api-Resource-Id`；
新接入建议直接用 `X-Api-Key`。

### HTTP Chunked / SSE

```http
POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
POST https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse
```

请求体（字段名以官方文档为准，下面是常用结构）：

```json
{
  "user": { "uid": "uid123" },
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

- `req_params.speaker` 是 2.0/1.0 音色 ID；复刻音色填 ICL 的声音 ID。
- `audio_params` 还支持语速、音量、情感、字幕等（`enable_subtitle`）。
- `req_params.model` 仅声音复刻 2.0 等场景使用，普通合成可省略。

响应是 chunked JSON，一行/一段一个对象：

```json
{"code": 0, "message": "", "data": "base64 音频片段", "sentence": null}
{"code": 20000000, "message": "OK", "data": null, "usage": {"text_words": 11}}
```

- `data` 为 base64 音频片段，按顺序拼接。
- 成功结束码 `20000000`；`40402003` 文本超限、`45000000` 音色未授权、
  并发超限看 `quota exceeded for types: concurrency`。
- SSE 版本会带 `event:`（`351` 句子结束、`352` 音频、`152` 结束、`153` 失败）。

### WebSocket

- 双向流式：`wss://openspeech.bytedance.com/api/v3/tts/bidirection`
- 单向流式：`wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream`

WebSocket 使用二进制协议帧（消息类型 + JSON/原始音频），适合实时对话；
只做朗读不需要。

## 3. 音色与声音复刻

- 小模型音色列表：`BV700_streaming` 等（见官方 Tonelist）。
- 大模型音色：`zh_female_wanqudashu_moon_bigtts`、
  `zh_female_vv_uranus_bigtts` 等，2.0 音色必须配 `seed-tts-2.0`。
- 声音复刻：先通过 ICL 接口上传参考音频得到 speaker ID，再用
  `X-Api-Resource-Id: seed-icl-2.0`（或 1.0）合成；复刻音色用 speaker ID
  作为 `speaker`/`voice_type`。
- 复刻/音色授权都要在控制台开通，未授权会返回 `speaker permission denied`
  或 `get resource id: access denied`。

## 4. 接入 dsh-whale-tts 的建议

- 新 provider id：`doubao`；Key 引用建议 `DOUBAO_API_KEY`（新版）或
  `DOUBAO_ACCESS_TOKEN` + `DOUBAO_APP_ID`（旧版）。
- 小模型适配最简单：JSON 请求 → `data` base64 解码 → `{ data, format: encoding }`；
  但文本上限 1024 UTF-8 字节（约 300 多个汉字），需要更细的分段。
- 大模型 V3 音质/音色更好，但需要：
  - 固定 headers（`X-Api-Key`、`X-Api-Resource-Id`）；
  - 解析 chunked/SSE JSON 并拼接 base64；
  - 维护 speaker/资源版本配置。
- 若要支持声音复刻，需要额外实现 ICL 上传/建模流程，建议独立里程碑。
- 输出格式推荐 `mp3`（体积小）或 `wav`（下游好处理）；采样率 24000 与现有
  播放链路兼容。
