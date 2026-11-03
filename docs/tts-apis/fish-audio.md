# Fish Audio TTS API

> 最后核对：2026-11-03
> 官方文档：
> - 文本转语音：https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
> - 声音模型/API：https://docs.fish.audio/api-reference

## 1. 能力概览

- 以「声音模型」为中心：每个 voice 是一个 `reference_id`，可以是预置模型、
  自己克隆的模型，或直接传参考音频做零样本克隆。
- 多语种，中文支持较好；支持多说话人（`reference_id` 传数组 + 文本里的
  `<|speaker:0|>` 标记）。
- 输出：`mp3` / `wav` / `opus` / `pcm`；可控制码率、分段长度、语速、音量。

## 2. 端点与认证

```http
POST https://api.fish.audio/v1/tts
Authorization: Bearer $FISH_AUDIO_API_KEY
Content-Type: application/json
```

## 3. 请求

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 待合成文本 |
| `reference_id` | string \| string[] | 否 | 声音模型 ID；数组表示多说话人 |
| `format` | string | 否 | `mp3`（默认）/`wav`/`opus`/`pcm` |
| `mp3_bitrate` | int | 否 | 64 / 128 / 192 |
| `chunk_length` | int | 否 | 100–300，长文本分段 |
| `normalize` | boolean | 否 | 文本规范化 |
| `latency` | string | 否 | `normal` / `balanced` |
| `prosody.speed` | number | 否 | 语速 |
| `prosody.volume` | number | 否 | 音量（dB） |
| `temperature` / `top_p` | number | 否 | 采样参数 |

```bash
curl -X POST https://api.fish.audio/v1/tts \
  -H "Authorization: Bearer $FISH_AUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "你好，我是育木的小鲸鱼。",
    "reference_id": "your-voice-model-id",
    "format": "mp3",
    "mp3_bitrate": 128,
    "latency": "normal"
  }' --output speech.mp3
```

## 4. 响应

- `200`：音频二进制（`Content-Type: audio/mpeg` 等）。
- 错误：`400` 参数/文本、`401` Key、`402` 额度不足、`429` 限流；
  错误体是 JSON。
- 声音模型列表/克隆接口见官方 API Reference；克隆得到的模型 ID 就是
  `reference_id`。

## 5. 接入 dsh-whale-tts 的建议

- 新 provider id：`fish-audio`；Key 引用 `FISH_AUDIO_API_KEY`。
- `synthesize()`：POST → 音频二进制；简单。
- `voice` 对应 `reference_id`；如果要做克隆，复用插件的样本上传，
  调 Fish 的模型创建接口，再把返回的模型 ID 存成档案。
- 中文质量和价格介于国产大厂与 ElevenLabs 之间，适合作为克隆型 provider。
